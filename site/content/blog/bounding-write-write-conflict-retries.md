+++
title = "Bounding retries of write-write conflicts in MVCC+2PL"
date = 2025-07-25

[taxonomies]
tags=["databases", "concurrency-control"]

[extra]
thanks = "Thanks to Alex Miller for feedback!"
+++

# Snapshot Isolation, Multi-versioning, & Two-phase Locking

It is common to implement snapshot isolation using multi-versioning and
two-phase locking (specifically write-locks). Much has been written on the
benefits of two-phase locking: once a transaction obtains a write lock, it is
not possible for there to be any new write-write conflicts on the protected
resource (a row predicate, table, etc). This means with two-phase locking, you
can detect a write-write conflict at the time of the write. But little has been
openly written on approaches to handling and retrying those write-write
conflicts once detected. This post will dive into possible approaches.

Let's start with a quick refresh of how snapshot isolation works with
MVCC+2PL. It allows for non-blocking snapshot reads (reads as of a version) as
they don't need to obtain any locks (remember that SI does not detect read-write
conflicts). Write transactions also perform non-blocking snapshot reads, and
then before performing a write (and the conflict check), they obtain a lock
protecting the resource. The conflict check is simply seeing if anything has
been written after the transaction's read version. The benefit of obtaining that
lock is well known: once a transaction obtains the write lock, it is not
possible for there to be any new write-write conflicts on the protected resource
(a row, predicate, table, etc.).

<!-- more -->

# Handling Write-Write Conflicts

So the database you are building detects a write-write conflict. The first thing
to build is a retry mechanism. When retrying the conflict, the way to avoid it
again is to retry the query with a read timestamp greater than the conflict's
commit timestamp. This eliminates the write-write conflict because the
conflicting write would be visible at the new read timestamp.

## Retryable Queries

To retry, however, we need to define what makes a statement retryable. In the
world of SQL, there are single-statement (non-interactive) transactions and
multi-statement (interactive) transactions. A retryable statement cannot
invalidate any results previously returned to the client. Invalidation is
breaking the semantics of the provided isolation level.

For Snapshot Isolation, because the read-timestamp must be refreshed, only a
single-statement or the first statement of a multi-statement can be
retried. Refreshing the read timestamp in a later statement would mean the
earlier statements were not performed at the same read timestamp. This breaks
the guarantee that a transaction operates on a single snapshot.

This also means a write that returns rows (see `RETURNING`) cannot retry once a
row has been returned.

## Retry Options

So, assuming the statement is retryable, what are a database implementer's
options?

The naive and simple solution is to free any write locks being held by the
transaction and retry the statement. This has an unbounded number of retries,
though, because when the lock is released, a different transaction can update a
row in the write set before the statement re-acquires the lock.

The better solution would be to hold those locks between retries. This is due to
that awesome guarantee of two-phase locking: once the lock is held, there will
be no new write-write conflicts. This property means we can bound the number of
retries.

In the solution space of holding locks between statement retries, there is a
spectrum between eager and lazy retries.

The eager approach is to retry on the first conflict. When encountering a
conflict, first obtain the lock and then retry. If encountering an uncommitted
transaction holding the lock, wait for the transaction to resolve and obtain the
lock. Either the conflicting transaction aborts and the transaction can make
progress without a retry, or it commits, resulting in the transaction retrying
(after obtaining the lock). This bounds the number of retries to N, where N is
the size of the write set. On each retry, the transaction has at least one more
row in its write set locked. If it isn't clear, that is why the lock ownership
is important. A transaction must obtain at least one more lock on each retry for
it to be bounded (i.e., to make forward progress).

The lazy approach is to retry only after all conflicts are resolved. When
encountering a conflict, mark it as conflicting but continue execution as of the
existing read timestamp. Only retry after the transaction owns all of the write
locks for the write set. This means wait for all conflicting transactions to
resolve and transfer lock ownership. Waiting for ownership of all locks bounds
the number of retries to 1, because on retry, the entire write set is locked,
guaranteeing that no new write-write conflicts will occur.

{{ load_data(path="blog/artifacts/lock_retries.svg") }}

The above graph visualizes the retry bounds given by each approach.

# Bounding the write set

Unfortunately, the retry bounds above oversimplify what happens in the real
world. It assumes the write set is the same after refreshing the read
timestamp. In reality, a query can have a bounded or unbounded write set. An
example of a bounded write set is `update where primary_key = 1`. There will
only ever be one row in the write set. An unbounded write set can have its write
set grow or change after every retry. There are two types of unbounded write
sets.

The first type is where the write set can infinitely grow, e.g. `update t where
t.value > 0`. There can be an infinitely growing number of rows with `value >
0`. The unbounded predicate is illustrated in the example below, which assumes
row-level locks.

<div class="table-wrapper">

| Ts  | Thread 1                | Thread 2                | Thread 3                                                                        |
|-----|-------------------------|-------------------------|---------------------------------------------------------------------------------|
| 1   | Commit Write K=1,V=1    |                         | Begin Txn                                                                       |
| 2   |                         | Commit Update K=1,V=V+1 |                                                                                 |
| 3   |                         |                         | Update where V > 0,V=V+1<br>(conflicts with T2's update)<br>(Locks K=1)         |
| 4   |                         | Commit Write K=2,V=1    | Retry statement                                                                 |
| 5   | Commit Update K=2,V=V+1 |                         |                                                                                 |
| 3   |                         |                         | Update where V > 0,V=V+1<br>(conflicts with T1's update)<br>(Locks K=1,2)       |
| ... | ...                     | ...                     | ...                                                                             |
| N   | Commit Write K=N,V=1    |                         | Retry statement                                                                 |
| N+1 |                         | Commit Update K=N,V=V+1 |                                                                                 |
| N+2 |                         |                         | Update where V > 0,V=V+1<br>(conflicts with T2's update)<br>(Locks K=1,2,...,N) |
| ... | ...                     | ...                     | ...                                                                             |

</div>

Repeat ad infinitum. The write-write conflicts occur because there is always a
new row in the write set that was not visible at the pre-retry timestamp, so it
will not be locked. Which means a different thread can keep updating that row
and cause write-write conflicts.

The second type is where the write set is always changing. This would be a query
with a complex predicate, e.g. `update t where (subselect from t2) =
t.key`. Even though we are locking down the write set, the other table can
continue to receive writes which change the statement's write set when
re-evaluated with a new read timestamp.

To solve this, we need to use a predicate shared-lock. The predicate shared-lock
prevents writes to all existing and possible rows (phantoms) that match the
predicate. This ensures when the statement is retried with a new read timestamp
the write set is unchanged. With the frozen write set, the bounds given in the
previous section are applicable again.

In the first example, `update t where t.value > 0`, a predicate shared-lock on
`value > 0` would work. It would prevent new writes to `K=N,V>0`, bounding the
write set to `0..N`. In the second example, `update t where (subselect from t2)
= t.key`, a predicate shared-lock on the range selected from t2 would work. At
the cost of concurrency (in favor of implementation simplicity) a table lock on
`t2` also suffices. They key point is as long as the write set is frozen, there
is a retry bound.

Also note that you can combine the two types of unbounded write sets. If the
second example used `t.value`: `update t where (subselect from t2) = t.value`,
then `t.value` is also part of the predicate and would need to be
locked. `t.key` is bounded but `t.value` is not, similar to the first
example. So the sub-select would need to be locked first, then the range of
`t.value` that matches sub-select would be locked second. At this point, from an
implementation perspective, falling back to table locks for `t2` and `t` looks
enticing. The predicates get complex fast.

# A Note about Deadlocks

While tangential to this post, an implementer needs to consider the deadlock
avoidance/detection system of the database because it involves releasing
locks. So any write-write conflict retry bounds for a statement are intimately
tied to the deadlock system's lock release mechanisms.

# Transparent Retrying

If you made it this far, you might still be wondering what is the importance of
bounding the number of retries?  It allows the database to guarantee retryable
statements will never surface write-write conflicts. Because write-write
conflicts have bounds on the number of retries, the database can retry them
internally until success. Now you have a database that, in some scenarios, has
eliminated write-write conflicts while still allowing concurrency.

Even if you don't go all the way to fully bounded & transparent retries, your
database is now much more client-friendly because the likelihood of write-write
conflicts surfacing to the client is diminished.
