+++
title = "Controlled Lock Violation w/ Multi-Versioned Concurrency Control for Snapshot Isolation"
date = 2024-12-30

[taxonomies]
series=["Pessimistic Concurrency Control"]
tags=["Concurrency Control", "Locking", "2PC"]
+++

# Background

There are two forms of concurrency control: pessimistic and
optimistic. Pessimistic concurrency control In the world of pessimistic
concurrency control, strict 2 phase locking is the standard.

<!--more-->

# Multi-Versioning w/ Row Locks

For the purposes of this post, multi-versioning is implemented as a version list
of values.

Multi-versioning is useful in pessimistic concurrency control. Read only
transactions never have to obtain any locks because reads access already
existing versions. They do a snapshot read as-of their timestamp.

## Snapshot Isolation

For snapshot isolation, one needs to detect and prevent write-write
conflicts. UNDONE: formal definition of write-write conflict. In PCC, obtaining
an exclusive lock (writes) on the row to prevent new write-write
conflicts. Before acquiring the exclusive lock, there needs to be a check for
any committed writes with a timestamp greater than the transaction's read
timestamp.

# Strict Two-Phase Locking

Traditional PCC uses strict two-phase locking. It builds up all of the
transaction's locks until the end of the transaction. Then holds them until the
transaction becomes durable upon which it can release.

It is beneficial to hold these locks for the shortest time period possible. The
longer a lock is held, the longer conflicting transactions are blocked. Hence
there is early lock release.

# Early Lock Release


## Shared Locks (Reads)

Shared locks can be released as soon as the transaction is finished, before
becoming durable.

## Exclusive Locks (Writes)

Transaction A releasing locks early means that Transaction B is reading dirty
data. Therefore, a commit dependency is created between A and B. There are two
things that this commit dependency means:

1. B must commit after A commits.
2. If A rolls back, B must abort/rollback.
3. B can operate on A's data inside the DBMS, but it must not return any of A's
   data to the client until A commits.

https://www.semanticscholar.org/paper/Efficient-Locking-Techniques-for-Databases-on-Kimura-Graefe/dca81f95026cd7525c083fcd4347085f15324e9a

MySQL InnoDB has early lock release, but they do not prevent Case 3. They
release locks before the fsync. Therefore they caution about dirty reads: B can
return some of A's data, and then there is a crash before A commits. A few more
details can be found here
https://web.archive.org/web/20241229100046/https://m.facebook.com/nt/screen/?params=%7B%22note_id%22:10157508562376696%7D&path=/notes/note/.

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

To support controlled lock violations, our versioned list needs to additionally
support the following:

* Multiple uncommitted nodes that are dependent on each other.
* Timestamps to determine uncommitted node visibility.

To do this, our versioned nodes include a new value, `ReleaseTs`. This is the
timestamp at which the row lock allows violations.

Read-only transactions still determine visibility using the `CommitTs`: the
latest node with `CommitTs <= ReadTs`. This is what ensures they read-only
transactions do have any completion dependencies. See UNDONE for more details.

Read-write transactions use the `ReleaseTs`: the latest node with `ReleaseTs <=
ReadTs`. This is what allows them to see the uncommitted nodes. Now we can go
through some scenarios to see what this looks like in practice using only
exclusive locks (snapshot isolation).

## Snapshot Isolation

### Write Locking

Multi-versioned snapshot isolation as outlined earlier just needs exclusive
locks.  Lets run through some scenarios to see how writes work in practice with
CLV. The initial state has two committed values, and an uncommitted chain with
three values. As stated above, each versioned node has a `ReleaseTs` and a
`CommitTs` (invalid values if not committed/allowing violations yet). `Txn A`
currently owns the exclusive lock on `V2` (it was the transaction that inserted
`V3`). `Txn H ReadTs < V3 ReleaseTs` and `Txn J ReadTs < V3 ReleaseTs` so they
can only read `V2`. Therefore, they wait on `V2` to be released instead. `V5`
which owns `Txn C` has not been released yet.

{{ load_data(path="static/images/clv_mvcc_t1.svg") }}

This next diagram shows the outcome of `Txn A` committing. Similar to
traditional strict 2PL snapshot isolation, all the waiters abort with a
write-write conflict. However, because we optimistically generated a linear
history based on `Txn A`, we are able to continue with the uncommitted
list. Additionally, `V5` started allowing violations.

{{ load_data(path="static/images/clv_mvcc_t2.svg") }}

Next up GC was performed removing some of the lower committed versions to make
the graphic easier for the reader. `Txn D (ReadTs = 7)` acquired the lock on
`V5` to insert `V6`. Notice that the read timestamp is less than `V4
CommitTs=9`. This is why using `ReleaseTs`/`CommitTs` for visibility choices is
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
are two locks in the uncontended case. The uncommitted node row locks should
ideally be lazily created.  This would reduce the overhead to `N-1` row locks
where `N` is the number of uncommitted nodes.

Some other overhead is the extra release timestamp. Similar to how one can store
the commit timestamp in the transaction, if all transaction locks are released
at the same timestamp, then the release timestamp can be stored once in the
transaction and shared across versioned lists.

Also, commit dependencies are built into the version list. The transaction does
not need to keep track of write commit dependencies as they will be encountered
during lock release.

Finally, what is cool is the workspace is on the final version list. There is no
private transaction buffer that writes need to operate on.

### Read Commit Dependencies

UNDONE: flesh this out. add a graphic

The write set is not always the same as the read set of a transaction. In order
to support controlled lock violations, we also need to build commit dependencies
for read rows.

### High Watermark Implementation

The controlled lock violation paper proposes high watermarks as a simple
implementation for commit dependencies on single node databases. It uses the
high watermark of the log. Transactions allow lock violations after determining
their commit LSN. Transactions check commit LSNs of its lock violations, and
store the max commit LSN of its dependencies. When the log's high watermark is
greater than the that max depedency commit LSN, its dependencies are durable and
the commit can proceed.

This simple implementation does not support efficient two-phase commits. As
detailed earlier, lock violations should be allowed during the prepare phase,
which is before the commit LSN is known.

Additionally, it is not efficient if the log supports out of order
commits. Imagine the following scenario. Txn B violated one of Txn A's
locks. Txn A is committed, but earlier in the log is a large Txn Z that is still
committed. Txn B can't commit because it needs to wait for the high water mark
to reach Txn A.

```
Txn Z (slow, committing) | Txn A (committed) | Txn B (waiting for HWM)
```

With a high watermark implementation, it may be faster for Txn A not to allow
the lock violation so Txn B could immediately acquire the lock and commit. If
the database does not support two-phase commit and does not use an out of order
log, it may be better to implement the read dependencies using high watermark.

### Two Phase Commit

UNDONE: flesh this out add graphic

### Insert Row Return

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

### Multi-statement

Multi-statement transactions have to use read-write visibility semantics. This
is because using the `CommitTs` for reads would hide your own writes from you if
they are not at the head of the uncommitted list. Additionally, mixing the two
visibilities depending on a read/write statement would mean the transaction is
seeing two different snapshots depending on the statement type.

This means read statements in a multi-statement may have commit
dependencies. The DBMS can operate internally on rows without waiting for known
outcomes. Commit dependencies only need to be only resolved for rows returned to
the client. This is required because forgoing waiting for commit dependencies
means dirty reads as uncommitted rows are returned.

The wait for resolution of commit dependencies should be lazily performed. Query
execution is likely to read more rows then actually returned to the user. Some
form of row tainting may be a solution here. Taint the row if it is uncommitted
data so when at the final stage of returning the row, a wait is performed. Or if
the row's versioned node is passed through all the stages of query execution, it
can check if the node is committed and wait if necessary.

Interestingly, one does not need to wait for commit dependencies if returning a
row that the transaction wrote. This is because the client is already expected
to be receiving uncommitted data. It also extends to the insert row return
statement. Because the statement is not expected to commit, it is always
expected that the rows returned are uncommitted. So regardless of the
guarantetes insert row return provides in the single-statement case, in
multi-statement no waiting is necessary.

As in the strict 2PL serializability case, snapshot isolation with controlled
lock violations can benefit from _read only multi-statement_ transactions. This
would use the `CommitTs` visibility for all read statements and prevent the
occurrence oof any completion dependencies.
