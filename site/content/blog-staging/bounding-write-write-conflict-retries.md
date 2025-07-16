+++
title = "Bounding retries of write-write conflicts in MVCC+2PL"
date = 2025-07-14

[taxonomies]
tags=[]
+++

# Snapshot Isolation, Multi-versioning, & Two-phase Locking

It is common to implement snapshot isolation using multi-versioning and
two-phase locking (specifically write-locks). Much has been written on the
benefits of two-phase locking: once a transaction obtains a write lock, it is
not possible for there to be any new write-write conflicts on the protected
resource (a row predicate, table, etc). This means with two-phase locking you
can detect write-write conflict at the time of the write. But little has been
openly written on approaches to handling and retrying those write-write
conflicts once detected. This post will dive into possible approaches.

Lets start with a quick refresh of how snapshot isolation works with
MVCC+2PL. It allows for non-blocking snapshot reads (reads as-of a version) as
they don't need to obtain any locks (remember that SI does not detect read-write
conflicts). Write transactions also perform non-blocking snapshot reads, and
then before performing a write (and the conflict check) they obtain a lock
protecting the resource. The conflict check is simply seeing if anything has
been written after the transaction's read version. The benefit of obtaining that
lock is well known: once a transaction obtains the write lock, it is not
possible for there to be any new write-write conflicts on the protected resource
(a row, predicate, table, etc.).

# Handling Write-Write Conflicts

So the database you are building detects a write-write conflict. The first thing
to build a retry mechanism. When retrying the way to avoid that write-write
conflict is to retry the query with a read timestamp greater than the commit
timestamp of the conflict. This eliminates the write-write conflict because the
conflicting write would be visible at the new read timestamp.

## Retryable Queries

In order to retry though we need to define what makes a statement retryable. In
the world of SQL there are single-statement (non-interactive) transactions and
multi-statement (interactive) transactions. A retryable statement cannot
invalidate any results previously returned to the client. Invalidation is
breaking the semantics of the provided isolation level.

So for Snapshot Isolation because the read-timestamp must be refreshed, only a
single-statement or the first statemetn of a multi-statement can be
retried. Refreshing the read timestamp in a later statement would mean the
earlier statements were not performed at the same read timestamp and the
guarantee that a transaction operates on a single snapshot is broken.

This also means a write that returns rows, ala `RETURNING`, cannot retry once a
row has been returned.

## Retry Options

So assuming the statement is retryable, what are a database implementers
options?

The naive and simple solution is to free any write locks being held by the
transaction and retry the statement. This has unbounded number of retries
though. Because when the lock is released a different transaction can update a
row in the write set before the statement re-acquires the lock.

The better solution would be to hold those locks between retries. This is
because of that amazing guarantee of two-phase locking: once the lock is held
there will be no new write-write conflicts. This property means we can bound the
number of retries.

In the solution space of holding locks between statement retries there is a
spectrum between eager and lazy retries.

The most eager approach is to retry on the first conflict. When encountering a
conflict first obtain the lock, and then retry. If encountering an uncommitted
transaction holding the lock, wait for the transaction to resolve and obtain the
lock. Either the conflicting transaction aborts and the transaction can make
progress without a retry, or it commits resulting in the transaction retrying
(after obtaining the lock). This bounds the number of retries to N, where N is
the size of the write set. On each retry the transaction has at least one more
row in it's write set locked. If it isn't clear, that is why the lock ownership
is important. A transaction must obtain at least one more lock on each retry in
order for it to be bounded (aka making forward progress).

The most lazy approach is to retry only after all conflicts are resolved. When
encountering a conflict mark it as conflicting but continue execution as-of the
existing read timestamp. Only retry after the transaction owns all of the write
locks for the write set. So wait for all conflicting transactions to resolve &
transfer lock ownership. This bounds the number of retries to 1. Because on
retry the entire write-set is locked guaranteeing that no new write-write
conflicts will occur.

# Bounding the write set

Unfortunately, the retry bound above over-simplified what happens in the real
world. They assume the write set is the same after refreshing the read
timestamp. In reality a query can have a bounded or unbounded write set. An
example of a bounded write set is `update where primary_key = 1`. There will
only ever be one row in the write set. While the query `update where value > 0`
is unbounded. There can be infinitely growing number of rows with `value >
0`. Another example of an unbounded write-set is a complex query where the
update's predicate is based on an ever-changing read. While the write-set at a
timestamp isn't growing, I still consider it unbounded because at each timestamp
there are new rows in the write-set.

An unbounded write set scenario could look like the following in a database
using row locks:

| Ts | Thread 1 | Thread 2 | Thread 3 |
|-|-|-|-|
| 1 | Write X=1,Y=1 | | Begin |
| 2 | | Update X=1,Y=Y+1 | |
| 3 | | | Update where x > 0,Y=Y+1 (conflict) |
| 4 | Write X=2,Y=1 | | Retry Ts |
| 5 | | Update X=2,Y=Y+1 | |
| 3 | | | Update where x > 0,Y=Y+1 (conflict) |

Repeat ad infinitum.

The row locks are continually growing, but every time the read is refreshed the
statement's write-set includes ever more/different rows. There is
forward-progress of lock acquisition but no bound on the number of locks that
need to be acquired. Thus, the database needs to lock down the write-set. With a
locked down write-set, the retry bounds given in the previous section apply
again.

This can be achieved with a write-lock on the read-set that influences the
write-set. This may need to be a gap-lock, a lock on rows that do not exist. In
the above scenario a predicate lock on `X > 0` would be best. But a brute-force
table lock also would work.

# A Note about Deadlocks

While tangential to this post, an implementer needs to consider the deadlock
avoidance/detection system of the database because those involve releasing
locks. So any write-write conflict retry bounds for a statement are intimately
tied to the deadlock system's lock release mechanisms.

# Transparent Retrying

If you made it this far you might still be wondering what is the importance of
bounding the number of retries?  It allows for the database to guarantee
retryable statements will never surface write-write conflicts. Because
write-write conflicts have bounds on the number of retries, the database can
retry them internally until success. Now you have a database that in some
scenarios has eliminated write-write conflicts while still allowing concurrency.

Even if you don't go all the way to fully bounded & transparent retries, your
database is now much more client-friendly because the likelihood of write-write
conflicts surfacing to the client is diminished.
