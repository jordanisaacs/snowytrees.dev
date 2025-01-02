+++
title = "Controlled Lock Violation w/ Multi-Versioned Concurrency Control for Snapshot Isolation"
date = 2024-12-30

[taxonomies]
series=["Pessimistic Concurrency Control"]
tags=["Concurrency Control", "Locking", "2PC"]
+++

# Background

There are two forms of concurrency control: pessimistic and
optimistic. Pessimistic concurrency control performs conflict checking early while optimistic concurrency control detects it at the end of the transaction.

<!--more-->

# Multi-Versioned Snapshot Isolation w/ Row Locks

For the purposes of this post, multi-versioning is implemented as a version list
of values. Additionally there is assumed to be some sort of deadlock
prevention/detection component (e.g. locks implemented as wait-die/wound-wait).

Combining multi-versioning with pessimistic concurrency control is very
effective for [snapshot
isolation](https://jepsen.io/consistency/models/snapshot-isolation). Reads
performed from the transaction's start timestamp. They have visibility of the
latest value with `CommitTs <= StartTs`. This is what gives them a lock-free
snapshot read.

In snapshot isolation one needs to detect and prevent write-write conflicts. A
read-write transaction will perform their reads as of the transaction's start
timestamp. Visibility is also based on `CommitTs <= StartTs`. Writes are
performed as of the transaction's commit timestamp. There is a detection phase
and then a prevention phase for write-write conflicts. First, the transaction
determines if any of its writes conflict with already committed writes. Is there
a committed node with `CommitTs > StartTs`.

UNDONE: a graphic

Then, it acquires an exclusive lock on the row. This prevents future concurrent
writers from also attempting to write a value (which would be a write-write
conflict).

UNDONE: some graphics

If the lock was already held, the transaction waits.

UNDONE: a graphic

## Strong Strict Two-Phase Locking

These locks are used to prevent write-write conflicts so it is important that
they are held for the duration of the transaction. Releasing the locks would not
cause dirty reads because the start timestamp of the transaction would still be
less than the early release commit timestamp (uncommited values would not have
one). This is known as strong strict two-phase locking.

In strong strict two-phase locking. A transaction builds up all of
its locks, releasing none of them until the transaction is durable. If locks are
released before the transaction is durable, you can get bad results. Imagine the
following example where `A = 0`.

UNDONE: some graphics

| Timestamp | Txn A  | Txn B  |
|---|---|---|
| 1  | Begin  |   |
| 2  |   | Begin  |
| 3  | A=3  |   |
| 4  | Release  |
| 5  |   | A=A+1  |
| 6  | Commit  |
| 7  |   | Commit |

The result is `A = 1` which is an undetected write-write conflict. `Txn B` did
not see `Txn A` because `Txn A` did not commit before `Txn B`'s read
timestamp. If the row was correctly locked, `Txn B` would have waited for `Txn
A` to commit and then detect a write-write conflict. Instead, it saw no lock was
held so it obtained it and wrote its own value.

As one can surmise, it is beneficial to hold these locks for the shortest time
period possible. The longer a lock is held, the longer conflicting transactions
are blocked reducing concurrency. For example in a single node transaction there
is the cost of writing durably to disk. The blue line is the duration of the
transaction. Performing for I/O can take significantly longer than the
transaction itself. In strict 2PL the locks are held for the entire
duration. Ideally we would hold locks only for the green arrow, until the commit
is requested.

> For example, assuming 40,000 instructions per transaction, 1 instruction per
> CPU cycle on average, a 4 GHz CPU clock, and no buffer faults, a modern
> processor core can execute the transaction logic in about 0.01 ms
> ...
> If stable storage for the recovery log is provided by flash storage, commit
> time might be faster by two orders of magnitude, i.e., 0.1 ms, but it is still
> an order of magnitude longer than transaction execution.

<p><img src="/images/clv-1pc.png" style="min-width:60%; max-width:90%;margin:0px auto;display:block"></p>

It is even worse with two-phase commit. We are holding locks across the prepare
I/O, network activity, and then the commit I/O. The blue line is the
entirety of the 2PC transaction. Ideally we hold locks just for the red
line. The line below also assumes communication time is neglible which is not
generally the case, there are network round trips to take into account.

> Traditional commit processing holds all locks for ... 0.21 ms (log on flash);
> early lock release holds all locks for ... 0.11 ms; and controlled lock
> violation enforces locks for only 0.01 ms (independent of the log device).

<p><img src="/images/clv-2pc.png" style="min-width:60%; max-width:90%;margin:0px auto;display:block"></p>

Therefore, there is the idea of releasing locks/allowing lock violations
early.

# Early Lock Release

Since this posts focuses on snapshot isolation which only uses exclusive locks
(writes), I will ignore the implications of early release of shared locks
(reads).

## Exclusive Locks

Transaction A releasing locks early means that Transaction B is reading dirty
data. Therefore, a commit dependency is created between A and B. There are two
things that this commit dependency means:

1. B can only commit after A commits.
2. If A rolls back, B must abort/rollback.
3. B can operate on A's data inside the DBMS, but it must not return any of A's
   data to the client until A commits.

https://www.semanticscholar.org/paper/Efficient-Locking-Techniques-for-Databases-on-Kimura-Graefe/dca81f95026cd7525c083fcd4347085f15324e9a

Case 3 is the rule preventing dirty reads. For example, MySQL InnoDB has early
lock release, but they do not prevent Case 3. They release locks before the
fsync. Therefore they caution about dirty reads: B can return some of A's data,
and then there is a crash before A commits. A few more details can be found in this
[Facebook note](https://web.archive.org/web/20241229100046/https://m.facebook.com/nt/screen/?params=%7B%22note_id%22:10157508562376696%7D&path=/notes/note/). UNDONE: use a citation

Implementing early lock release with correct commit dependencies is very tricky.

### Two-Phase Commit

UNDONE: the problems here

# Controlled Lock Violations

https://www.semanticscholar.org/paper/Controlled-lock-violation-Graefe-Lillibridge/6f1db2c7917e57c077d06841e175a1bb062b5015

Controlled lock violations are a slight reframing of early lock release that
makes implementation significantly more simple. Instead of releasing the lock,
the lock instead allows violations.

The paper's implementation focused on B-trees and using a flag to allow
violations. What follows is my own ideas on implementing controlled lock
violation in multi-versioning.

UNDONE: add graphics from paper.

## Multi-Versioning

To support controlled lock violations, our versioned list needs to support the
following:

* Multiple uncommitted nodes that are dependent on each other.
* Timestamps to determine uncommitted node visibility.

To do this, our versioned nodes include a new value, `ViolationTs`. This is the
timestamp at which the locked uncommitted node allows violations.

Read-only transactions still determine visibility using the `CommitTs`: the
latest node with `CommitTs <= StartTs`. This is what ensures read-only
transactions do not read uncommitted data and incur commit dependencies.

Read-write transactions use the `ViolationTs`: the latest node with `ViolationTs
<= StartTs`. This is what allows them to see the uncommitted nodes. The
consequence being reads and writes in a read-write transaction generate commit
dependencies.

## Snapshot Isolation

### Write Locking

Multi-versioned snapshot isolation as outlined earlier just needs exclusive
locks.  Lets run through some scenarios to see how writes work in practice with
CLV. The initial state has two committed values, and an uncommitted chain with
three values. As stated above, each versioned node has a `ViolationTs` and a
`CommitTs` (invalid values if not committed/allowing violations yet). `Txn A`
currently owns the exclusive lock on `V2` (it was the transaction that inserted
`V3`). `Txn H StartTs < V3 ViolationTs` and `Txn J StartTs < V3 ViolationTs` so they
can only read `V2`. Therefore, they wait on `V2` to be released instead. `V5`
which owns `Txn C` has not been released yet.

{{ load_data(path="static/images/clv_mvcc_t1.svg") }}

This next diagram shows the outcome of `Txn A` committing. Similar to
traditional strict 2PL snapshot isolation, all the waiters abort with a
write-write conflict. However, because we optimistically made progress on the
history based on `Txn A`, we are able to continue with the uncommitted
list. Additionally, `V5` started allowing violations.

{{ load_data(path="static/images/clv_mvcc_t2.svg") }}

Next up GC was performed removing some of the lower committed versions to make
the graphic easier for the reader. `Txn D (StartTs = 7)` acquired the lock on
`V5` to insert `V6`. Notice that the read timestamp is less than `V4
CommitTs=9`. This is why using `ViolationTs`/`CommitTs` for visibility choices is
important. The commit timestamp is greater than the timestamps in the
uncommitted chain. But our read-write transactions need to have visibility into
the uncommitted chain.

{{ load_data(path="static/images/clv_mvcc_t3.svg") }}

Finally a demonstration of a cascading abort. `Txn C` aborts which also causes
`Txn D` to abort. Because `Txn K` was waiting on `V4` which `Txn C` originally
owned, it now has acquired the exclusive lock and inserted its own `V5`.

{{ load_data(path="static/images/clv_mvcc_t4.svg") }}

You may have noticed some properties after seeing some diagrams of how it
works. First is every uncommitted node has its own row lock. This means there
are two locks in the uncontended case, the committed node lock and the
uncommitted node lock. I wonder if the uncommitted node row locks can be lazily
created and if that would be more space efficient. This would reduce mean the
overhead is `N` row locks where `N` is the number of uncommitted nodes (assuming
the committed row lock always exists).

Some other overhead is the extra release timestamp. Similar to how one can store
the commit timestamp in the transaction, if all transaction locks are released
at the same timestamp, then the release timestamp can be stored once in the
transaction and shared across versioned lists.

Finally, another nice feature is the uncommitted workspace *is* the final
version list. Writes do not need to operate on a private transaction buffer as
there is only one potential history at a time.

### Waiter Behavior

With lock violations the assumption is made that transactions won't abort once
violations are allowed. This raises the question of waiters why waiters should
wait until _commit_ to get a write-write conflict instead of making the decision
at _release_ time.

My educated assumption is deciding write-write conflicts post _release_ is
better. This causes the transaction/user to retry faster, because we are
assuming the commit will happen. With the retry, the restarted transaction will
have a later read timestamp and thus deeper access to the uncommitted version
list to make progress.

### Violation Atomicity

For correctness, setting violations does not need to be performed for all writes
in a transaction at the same time. This is because a transaction will end up
waiting for the outcome if the lock is not allowing violations (it does not just
ignore the value). However in practice allowing violations should be performed
atomically. Imagine the following scenario with non-atomic violations:

{{ load_data(path="static/images/clv_mvcc_atomic.svg") }}

If `Txn A` commits, `Txn B` will abort because it is a waiter on `Txn A` in
Versioned List A. If `Txn A` aborts, `Txn B` will abort because it is dependent
on `Txn A` in Versioned List B. If the violation timestamp was set atomically
for all writers this would be avoided.

Visibility of violations does need to be atomic, similar to commits. Otherwise
`Txn B` would be a waiter on `Txn A`'s V2 even though the `ViolationTs <=
StartTs`.

### Commit Dependencies

A handy benefit of the versioned list is commit dependencies are embedded in
it. Transactions do not need to keep track of write dependents as during lock
release they will visible in the version list.

However, the write set is not necessarily the same as the read set of a
transaction. We also need to track commit dependencies for read rows. This is
because we may be reading uncommitted data. So the transaction must wait for all
read rows to be committed and abort if necessary before committing.

To implement this we can use the ideas from https://www.semanticscholar.org/paper/High-Performance-Concurrency-Control-Mechanisms-for-Larson-Blanas/7ce9e2064bfe1d50ca59edecff8da40604985c0d

Each transaction, `T`, will have three new fields:

* `ReadCommitDepSet`: A set of all the read transaction ids that depend on `T`.
* `CommitDepCounter`: A counter of all (read + write) transactions that `T` depends on.
* `AbortNow`: A boolean flag that other transactions can set to tell `T` to abort.

When `T` acquires an exclusive lock through controlled lock violation, it
increments its own `CommitDepCounter`. When `T` performs a controlled lock violation
for a read on another transaction, it increments its own `CommitDepCounter`, and
adds itself to the other transaction's `ReadCommitDepSet`. It only does this for
the node that is actually read (it may have iterated through X uncommitted nodes
before it).

During a commit/abort, `T` will iterate through its `ReadCommitDepSet` and
decrement the transaction's `CommitDepCounter`. During lock release, it will
also decrement the next node in the version's list `CommitDepCounter`. If it was
an abort, it additionally will set the `AbortNow` flag on all the transactions.

In the following scenario, `Txn A` has not performed any lock violations so
`CommitDepCounter = 0`. `Txn B` violated the lock and read the V2 from `Txn B`,
so it added itself to the `ReadCommitDepSet` and incremented its own
`CommitDepCounter`.

{{ load_data(path="static/images/clv_mvcc_read.svg") }}

#### High Watermark Implementation

The controlled lock violation paper proposes high watermarks as a simple
implementation for commit dependencies on single node databases. It uses the
high watermark of the log. Transactions allow lock violations after determining
their commit LSN. Transactions check commit LSNs of its lock violations, and
store the max commit LSN of its dependencies. When the log's high watermark is
greater than the that max dependency commit LSN, its dependencies are durable and
the commit can proceed.

This simple implementation does not support efficient two-phase commits. As
detailed earlier, lock violations should be allowed during the prepare phase,
which is before the commit LSN is known. Using the high watermark would only
allow violations during the commit phase.

Additionally, it is not efficient if the log supports out of order
commits. Imagine the following scenario. Txn B violated one of Txn A's
locks. Txn A is committed, but earlier in the log is a large Txn Z that is still
committed. Txn B can't commit because it needs to wait for the high water mark
to reach Txn A.

```
Txn Z (slow, committing) | Txn A (committed) | Txn B (waiting for HWM)
```

With a high watermark implementation, it may be faster for Txn A not to allow
the lock violation so Txn B could immediately acquire the lock and commit

If the database does not support two-phase commit and does not use an out of
order log, it can be simpler to implement the read dependencies using high
watermark. There would still need to be the `CommitDepCounter` and `AbortNow`
for write dependencies unless those also participated in the high watermark.

### Two Phase Commit

UNDONE: flesh this out add graphic

### Write Row Return

When returning rows from a single-statement write statement, e.g. using
PostgreSQL's
[Returning](https://www.postgresql.org/docs/current/dml-returning.html) or MSSQL
Server
[Output](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql?view=sql-server-ver16),
the behavior depends on the guarantees you want to provide.

If the results are of committed writes only, the inserted rows should return after
the commit is durable as expected. If the behavior is similar to MSSQL Server,

> An UPDATE, INSERT, or DELETE statement that has an OUTPUT clause will return
> rows to the client even if the statement encounters errors and is rolled
> back. The result shouldn't be used if any error occurs when you run the
> statement.

then it is possible to stream the results back immediately for single-statement
transactions. This is because the statement will fail (the implicit commit) if
any of the commit dependencies fail.

### Multi-Statement

Multi-statement transactions have to use read-write visibility semantics. This
is because using the `CommitTs` for reads would hide your own writes from you if
they are not at the head of the uncommitted list. Additionally, mixing the two
visibilities depending on a read/write statement would mean the transaction is
seeing two different snapshots depending on the statement type.

#### Preventing Dirty Reads

This means read statements in a multi-statement may have commit dependencies
from reading dirty rows. The DBMS can operate internally on these rows without
waiting for known outcomes. However, commit dependencies must be resolved for
rows returned to the client. The transaction needs to wait for the dirty row to
become a committed row.

The wait for resolution of commit dependencies should be lazily performed. Query
execution is likely to read more rows then actually returned to the user. Some
form of row tainting may be a solution here. The transaction could taint the row
with a txn id if it is uncommitted so when at the final stage of returning the
row, a check/wait can be performed. If the query engine passes through the
versioned node, then it already has access to the transaction to check/wait on.

A nice optimization is when returning rows that the transaction wrote, one does
not need to wait for commit dependencies. This is because the client is
expecting that they are receiving uncommitted data. It also extends to the
write row return statement. Because the statement is not expected to commit, it
is always expected that the rows returned are uncommitted. So regardless of the
guarantees write row return provides in the single-statement case, in the
multi-statement no waiting is necessary.

#### New Multi-Statement Types

There are two new types of multi statement transactions that can be useful with
controlled lock violation.

**Read only multi-statement transactions**

Because read queries have higher overhead in read-write transactions, having
read-only multi-statement transactions would allow for multiple read queries as
of the same timestamp with zero overhead. They would use the `CommitTs`
visibility rule for all the queries which prevents commit dependencies. As the
name implies, attempting to do a write query in a read-only multi statement
would produce an error.

**Dirty read multi-statement transactions**

Sometimes a multi-statement transaction that does reads and writes does not care
about dirty reads. Imagine a transaction that reads some rows, does some
processing outside of the database on them (e.g. building a full-text index or
an embedding), then inserts the processed data back into the database. The
client does not care that the data may be uncommitted because the data is only
being used in the context of the transaction. The transaction commit will fail
if one of the commit dependencies aborted. It can be thought of as extending the
internal DBMS' use of dirty reads to the user transaction. These types of
transactions should be able to opt out of the wait for commit overhead.

# Conclusion
