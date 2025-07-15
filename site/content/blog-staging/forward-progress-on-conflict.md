+++
title = "Forward progress guarantees for write-write conflicts"
date = 2025-07-14

[taxonomies]
tags=[]
+++

# Snapshot Isolation, Multi-versioning, & Two-phase Locking

There is a lot of literature on two-phase locking and multi-versioning for
snapshot isolation. But little has been written on what can be done if a
write-write conflict is detected after obtaining the write lock.

Lets start with a quick refresh of how snapshot isolation works with
MVCC+2PL. It allows for non-blocking snapshot reads (reads as-of a version) as
they don't need to obtain any locks (remember that SI does not detect read-write
conflicts). Write transactions also perform non-blocking snapshot reads, and
then before performing a write (and the conflict check) they obtain a lock
protecting the resource. The conflict check is simply seeing if anything has
been written after the transaction's read version. The benefit of obtaining that
lock is well known: once a transaction obtains the write lock, it is not
possible for there to be any new write-write conflicts on the protected resource
(a row, predicate, table, etc.). But what should be done if a write-write
conflict _is_ detected?

# Handling Write-Write Conflicts

Not all is lost for a transaction when a write-write conflict is detected. You
don't have to go back to your application and re-architect it to avoid
write-contention. This is because the database can give a forward progress
guarantee. It all hinges on that key guarantee of obtaining a write lock: it is
not possible for there to be any new write-write conflicts on the protected
resource. Now before reading on for the answer, see if you can put two-and-two
together.

...

...

In most scenarios, it is as simple as not giving up the locks before retrying
the transaction on a write-write conflict. This is because no new write-write
conflicts will occur on the newly locked resource (and the transaction keeps its
previously locked resources). The number of protected resources that the
transaction holds continually grows until it holds locks on all its requested
resources. And thus it will encounter no write-write conflicts and will be able
to commit.

In order for this to work, the retried transaction must use a read timestamp
that is greater than the conflicting write's commit timestamp. Otherwise it
would encounter the exact same write-write conflict again.

# Guaranteeing forward progress

The retrying of the query with a new read timestamp makes giving a forward
progress guarantee more complex than just holding existing locks in some
scenarios. This is because when the read timestamp is refreshed, the write set of
the query can change. It is possible that the write set on retry contains
resources that have not yet been locked. Concretely it could look like the
following in a database with only row locks:

| Ts | Thread 1 | Thread 2 | Thread 3 |
|-|-|-|-|
| 1 | Write X=1,Y=1 |      | Begin |
| 2 |            | Update X=1,Y=Y+1 | |
| 3 | | | Update where x > 0,Y=Y+1 (conflict) |
| 4 | Write X=2,Y=1 |        | Retry Ts |
| 5 |                  | Update X=2,Y=Y+1 | |
| 3 | | | Update where x > 0,Y=Y+1 (conflict) |

Repeat ad infinitum.

While the row locks held are continually growing, because the read timestamp is
refreshed, so is the write set. It keeps including new rows that have not yet
been locked which means potential write-write conflicts. In order to guarantee
forward progress there needs to be a mechanism to lock down the write set, namely
a gap-lock. In this scenario a predicate lock on `X > 0`, or even a table
lock, would work.

I imagine that in most scenarios there will not be unbounded growth of a
write-set. Any query that has a bounded write set, e.g. `update where
primary_key = 1`, will eventually acquire every lock. Or it is an unbounded
write set on bounded data, e.g. `update where x > 0` but `x > 0` is not growing
unbounded. Thus the transaction would obtain all the required locks without
needing gap-locking after a few write-write conflict retries.

# Corollary with Deadlock Avoidance

Conceptually I think about it as a corollary to deadlock detection/avoidance.
On (potential) deadlocks the transaction is "aborted" in that locks
are released. But "abort" is a little bit of a misnomer as the transaction in-fact
retries. It will keep its transaction timestamp so it eventually becomes the
oldest transaction on the system. At which point the transaction is guaranteed
precedence in the deadlock prevention.

Similarly when a transaction has a write-write conflict it will refresh its
read timestamp, but keep its locks. Eventually it will have obtained all
the locks it needs in order to make progress.

Guaranteeing forward progress for write-write conflicts works best when
combining it with a deadlock policy that waits for an unlock. Because with
NOWAIT even if a query re-encounters the unlocked row, it would have to retry on
a write-write conflict.

# Wrapping up

Using MVCC+2PL can give forward progress guarantees in the face of write-write
conflicts if locks are held on retries and the write set is prevented from
growing ad infinitum. If any readers know about literature that goes deeper into
transparent handling of conflicts please reach out!
