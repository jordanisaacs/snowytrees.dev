+++
title = "Controlled Lock Violation w/ Multi-Versioning for Snapshot Isolation"
date = 2024-12-30

[taxonomies]
series=[]
tags=[]

[extra]
noindex = true
+++

UNDONE: add back tags/series

# Introduction

There are two forms of concurrency control: pessimistic and
optimistic. Pessimistic concurrency control performs conflict checking early
while optimistic concurrency control detects it at the end of the transaction.

UNDONE: flesh out introduction

<!--more-->

# Multi-Versioned Snapshot Isolation w/ Row Locks

For the purposes of this post, multi-versioning is implemented as a version list
of values which constitute a row. Additionally, there is assumed to be some sort
of deadlock prevention/detection component (e.g. locks implemented as
wait-die/wound-wait).

Combining multi-versioning with pessimistic concurrency control is very
effective for snapshot isolation. Read transactions do not block read-write
transactions. Reads work simply by doing a read of the latest value with
`CommitTs <= StartTs`. No concurrency control is needed. Only read-write
transactions need concurrency control.[^1]

Because we are using snapshot as the isolation level, there is no need to
distinguish between two types of the read transactions. We don't need to provide
a serializable read that participates in concurrency control.

For snapshot isolation, we need to detect and prevent write-write
conflicts. Write-write conflicts are when another transaction, `Txn B`, writes
to the same row as `Txn A`, such that `StartTs_A <= CommitTs_B <=
CommitTs_A`. In plain english, `Txn B` inserted a row that was not visible to
`Txn A`, so when `Txn A` tries to write to the row it will have a write-write
conflict. In order to implement this with pessimistic concurrency control, we
only need exclusive locks. Once `Txn A` acquires an exclusive lock of the row,
it is guaranteed that no other transaction will commit a value with a commit
timestamp less than `Txn A`.

A read-write transaction will perform their reads as of the transaction's start
timestamp. As with read transactions, visibility is based on `CommitTs <=
StartTs`. Writes are performed as of the transaction's commit timestamp. There
is a detection phase and then a prevention phase for write-write
conflicts. First, the transaction determines if any of its writes conflict with
already committed writes. It asks, is there a committed node with `CommitTs >
StartTs`?

In Figure 1, the `Txn B` encountered a value with `CommitTs > StartTs` so it
fails with a write-write conflict.

{% load_data(path="blog/artifacts/mvcc_conflict.svg") %} Figure 1. Write-Write
Conflict.  {% end %}

Now, lets look at the happy case where `Txn A` sees no write-write conflicts. It
acquires the row lock and inserts its uncommitted value into the version
list. Because it does not have a `CommitTs`, no reads or read-write transactions
have visibility of the uncommitted data (except for `Txn A` itself).

{% load_data(path="blog/artifacts/mvcc_t1.svg") %} Figure 2. Row lock
acquisition.  {% end %}

Then `Txn B` comes and wants to perform a write. It can't because `Txn A` owns
the lock, so it waits. It is not a write-write conflict because the value is
still uncommitted.

{% load_data(path="blog/artifacts/mvcc_t2.svg") %} Figure 3. Row lock waiter.
{% end %}

When `Txn A` commits, all of the waiters now have a write-write conflict so they
abort. `CommitTs > StartTs` for all waiters.

{% load_data(path="blog/artifacts/mvcc_commit.svg") %} Figure 4. Transaction
commit.  {% end %}

If `Txn A` aborted instead, the first waiter, `Txn B`, will now own the row lock
and can now insert its value into the version list and continue making progress.

{% load_data(path="blog/artifacts/mvcc_abort.svg") %} Figure 5. Transaction
abort.  {% end %}

Using PCC with multi-versioning eliminates the need for transaction private
buffers for writes. Uncommitted values are able to be written in-place on the
versioned list.

[^1]: Arvola Chan, Stephen Fox, Wen-Te K. Lin, Anil Nori, and Daniel
	R. Ries. 1982. [The implementation of an integrated concurrency control and
	recovery scheme. In Proceedings of the 1982 ACM SIGMOD international
	conference on Management of data (SIGMOD
	'82)](https://www.semanticscholar.org/paper/The-implementation-of-an-integrated-concurrency-and-Chan-Fox/645f46933f49aa0ee730d7cac4af77c537a45950). Association
	for Computing Machinery, New York, NY, USA,
	184–191. <https://doi.org/10.1145/582353.582386>

## Strict Two-Phase Locking

To prevent dirty reads and cascading aborts with a simple implementation, strict
two-phase locking can be used. Locks are acquired throughout the transaction,
the _growing phase_. Locks are only released after the transaction is
durable. The next section goes into the implications of releasing locks before
the transaction is durable.

# Early Lock Release

As one can surmise, it is beneficial to hold these locks for the shortest time
period possible. The longer a lock is held, the longer conflicting transactions
are blocked reducing concurrency. At the cost of more complexity, we can
optimize how we hold locks after the _growing phase_ to enable higher
concurrency without dirty reads. There can be cascading aborts, albeit unlikely.

Because there is still a _growing phase_, the earliest we can release and still
stay consistent with 2PL is after the commit request, no more locks will be
acquired. This means locks can be released during the hardening stage. The
hardening stage can be the dominant part of a transaction in OLTP workloads so
enabling transaction progress during it can greatly increase performance during
conflicts.

In figure 6 below, the blue line is the duration of a single node
transaction. In strict 2PL the locks are held for the entire duration. With
early lock release we only hold it for the green line as described above.

{%load_image(path="/images/clv-1pc.png", fig=4)%} Figure 6. Single Node Lock
Release.  {% end %}

Releasing locks early can result in cascading aborts. However, in single node
transactions we are doing the early lock release during the hardening
stage. Generally, the only way a transaction aborts in this stage is if the
database crashes. Therefore, cascading aborts do not matter. Waiting is strictly
worse than speculatively proceeding, because if the database crashes the waiters
would also abort.

A traditional early lock release implementation releases locks after determining
its commit LSN. Assuming LSNs are strictly increasing, this creates a
barrier. All transactions, acquiring the lock after the release will have a
later commit LSN. Thus it satisfies the following:

1. B can only commit after A commits.

However, this does not hold for read-only read-write transactions that do not
commit anything and thus do not acquire a commit LSN. Imagine `Txn A` releasing
its locks, `Txn B` returns those rows, and then the database crashes before `Txn
A` is durable. That is a dirty read. This is what MySQL InnoDB seemingly
implements for early lock release. They release locks before the
fsync. Therefore they caution about dirty reads: B can return some of A's data,
and then there is a crash before A commits.[^2]

Therefore we need a new rule:

2. B can operate on A's data inside the DBMS, but it must not return any of A's
   data to the client until A commits.

This is the rule that prevents dirty reads. This check can be implemented as a
tag in the lock that stores the commit LSN of the latest release. In a
read-write transaction that only performed reads, it will wait for the commit
LSN to become durable.[^3]

However, the high watermark is not efficient if the log supports out of order
commits. Imagine the following scenario. `Txn B` violated one of `Txn A`'s
locks. `Txn A` is committed, but earlier in the log is a large `Txn Z` that is
still committed. `Txn B` can't commit because it needs to wait for the high
water mark to reach `Txn A`.

```
Txn Z (slow, committing) | Txn A (committed) | Txn B (waiting for HWM)
```

With a high watermark implementation, it may be faster for `Txn A` to not allow
the lock violation so `Txn B` could immediately acquire the lock and commit. For
correctness, this also assumes the out of order log will crash if one of the
commits fails. Otherwise high watermark does not mean all transactions below are
committed.

Additionally, this simple implementation does not support efficient two-phase
commits. In two-phase commit there is the prepare phase and then the commit
phase.  Using high watermark only allows violations during the hardening of the
commit phase. We are holding the much longer than necessary (the green line
instead of red line).

{%load_image(path="/images/clv-2pc.png", fig=4)%} Figure 7. 2PC Lock Release.
{% end %}

Therefore, we want a third rule to handle 2PC.

3. B must abort if A aborts.

We are assuming here that 2PC aborts are rare because they can cause cascading
aborts on failure. Unlike in the single node transaction, where waiters would
also have been aborted (because of crash), waiters on the 2PC abort would still
make progress. In the happy case though of 2PC succeeding, a 2PC transaction
holds locks for the same amount of time as a 1PC transaction. There is still the
overhead of a longer time to commit, but conflicting transactions are able to
make progress in parallel.

If 2PC aborts have periods of high occurrence, the DBMS could dynamically switch
from early lock release during the prepare phase to early lock release during
the commit hardening phase, the green line. This would reduce concurrency but
eliminate cascading aborts due to 2PC aborts.

[^2]: [MySQL Early Lock
	Release](https://web.archive.org/web/20241229100046/https://m.facebook.com/nt/screen/?params=%7B%22note_id%22:10157508562376696%7D&path=/notes/note/).

[^3]: Kimura, H., Graefe, G., & Kuno, H.A. (2012). [Efficient Locking Techniques
	for Databases on Modern
	Hardware](https://www.semanticscholar.org/paper/Efficient-Locking-Techniques-for-Databases-on-Kimura-Graefe/dca81f95026cd7525c083fcd4347085f15324e9a). ADMS@VLDB.

# Controlled Lock Violations

Controlled lock violations are a slight reframing of early lock release. Instead
of releasing the lock, the lock instead allows violations. The paper's
implementation focuses on non-versioned B-trees with a wide variety of locks and
the use of a flag to allow violations.[^4] What follows below are ideas that I
have on applying controlled lock violations to the multi-version snapshot
isolation scheme I introduced earlier.

The multi-versioned snapshot isolation as I talk about in this post does not
really have such thing as early lock release to begin with. Because the locks
are embedded in the versioned list (through uncommitted nodes), and there is
only a single type of lock, it is impossible to "release". The versioned list
keeps the lock history.

If one wanted to use these ideas on implementing controlled lock violations for
multi-versioning in a separate lock manager or with hierarchical locking, then
the controlled lock violation approach becomes clearer. There would be multiple
versions of a lock in the lock manager.

[^4]: Goetz Graefe, Mark Lillibridge, Harumi Kuno, Joseph Tucek, and Alistair
	Veitch. 2013. [Controlled lock
	violation](https://www.semanticscholar.org/paper/Controlled-lock-violation-Graefe-Lillibridge/6f1db2c7917e57c077d06841e175a1bb062b5015). In
	Proceedings of the 2013 ACM SIGMOD International Conference on Management of
	Data (SIGMOD '13). Association for Computing Machinery, New York, NY, USA,
	85–96. <https://doi.org/10.1145/2463676.2465325>

# Multi-Version Lock Violations

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

Write-write conflicts still are following the same logic but instead we can
reframe it as violation timestamps. `StartTs_A <= ViolationTs_B <=
ViolationTs_A`. If there is a write-write conflict where `Txn B` is committed,
then `Txn A` must abort. If there are no committed write-write conflicts, then
`Txn A` looks for the latest node where `ViolationTs <= StartTs`. If the node is
unlocked then it can lock it. Since it has the lock, it is guaranteed that there
will be no write-write conflicts. It now has a dependency though on the
uncommitted node below it. If the node is locked, then it becomes a waiter.

## Write Locking

Multi-versioned snapshot isolation as outlined earlier just needs exclusive
locks.  Lets run through some scenarios to see how writes work in practice with
CLV. The initial state, seen in figure 8, has two committed values, and an
uncommitted chain with three values. As stated above, each versioned node has a
`ViolationTs` and a `CommitTs` (invalid values if not committed/allowing
violations yet). `Txn A` currently owns the exclusive lock on `V2` (it was the
transaction that inserted `V3`). `Txn H StartTs < V3 ViolationTs` and `Txn J
StartTs < V3 ViolationTs` so they can only read `V2`. Therefore, they wait on
`V2` to be released instead. `V5` which owns `Txn C` has not been released yet.

{%load_data(path="blog/artifacts/clv_mvcc_t1.svg")%} Figure 8. Initial state
with controlled lock violation.  {% end %}

Figure 9 shows the outcome of `Txn A` committing. Similar to traditional strict
2PL snapshot isolation, all the waiters abort with a write-write
conflict. However, because we optimistically made progress on the history based
on `Txn A`, we are able to continue with the uncommitted list. Additionally,
`V5` started allowing violations.

{% load_data(path="blog/artifacts/clv_mvcc_t2.svg") %} Figure 9. Transaction
commit.  {% end %}

Next up GC was performed removing some of the lower committed versions to make
the graphic easier for the reader. `Txn D (StartTs = 7)` acquired the lock on
`V5` to insert `V6`. Notice that the read timestamp is less than `V4
CommitTs=9`. This is why using `ViolationTs`/`CommitTs` for visibility choices
is important. The commit timestamp is greater than the timestamps in the
uncommitted chain. But our read-write transactions need to have visibility into
the uncommitted chain.

{% load_data(path="blog/artifacts/clv_mvcc_t3.svg") %} Figure 10. Transaction
commit.  {% end %}

Finally a demonstration of a cascading abort. `Txn C` aborts which also causes
`Txn D` to abort. Because `Txn K` was waiting on `V4` which `Txn C` originally
owned, it now has acquired the exclusive lock and inserted its own `V5`.

{% load_data(path="blog/artifacts/clv_mvcc_t4.svg") %} Figure 11. Cascading
abort.  {% end %}

You may have noticed some properties after seeing diagrams of how it
works. First is every uncommitted node has its own row lock. This means there
are two locks in the uncontended case, the committed node lock and the
uncommitted node lock. I wonder if the uncommitted node row locks can be lazily
created and if that would be more space efficient. This would reduce the
overhead to `N-1` row locks where `N` is the number of uncommitted nodes
(assuming the committed row lock always exists). This is important because that
is a 50% savings in the uncontended case.

Other overhead is the extra release timestamp. Similar to how one can store the
commit timestamp in the transaction, if all transaction locks are released at
the same timestamp, then the release timestamp can be stored once in the
transaction and shared across versioned lists. Instead of storing two timestamps
per node.

Finally, another very nice feature is the uncommitted workspace is still the
final version list. Writes do not need to operate on a private transaction
buffer as there is only one potential history at a time. The difference from
before is we now have support for more than one uncommitted node.

## Waiter Behavior

The entire premise of lock violations is that it is extremely rare for
transactions to abort once violations are allowed. This raises the question of
waiters why waiters should wait until _commit_ to get a write-write conflict
instead of making the decision at _release_ time.

I believe deciding write-write conflicts post _release_ is better (albeit not
used in the scenarios above). This will force the transaction/user to retry
faster, and obtain a later read timestamp. Thus, it will have deeper access to
the uncommitted version list to make progress.

## Violation Atomicity

For correctness, allowing violations does not need to be performed for all
writes at the same time. This is because a transaction will end up waiting for
the outcome if the lock does not allow violations. However in practice allowing
violations should be performed atomically. Take the scenario in figure 12 that
uses multiple violation timestamps.

{% load_data(path="blog/artifacts/clv_mvcc_atomic.svg") %} Figure 12. Multiple
violation timestamps.  {% end %}

If `Txn A` commits, `Txn B` will abort because it is a waiter on `Txn A` in
Versioned List A. If `Txn A` aborts, `Txn B` will abort because it is dependent
on `Txn A` in Versioned List B. If the violation timestamp was set atomically
for all writers this would be avoided.

Visibility of violations does need to be atomic though, just as
commits. Otherwise `Txn B` would be a waiter on `Txn A`'s V2 even though the
`ViolationTs <= StartTs`.

## Violation Timestamps

You may have noticed that violation timestamps do not interact with commit
timestamps. Transactions that read using violation timestamps do not care about
commit timestamps, and vis versa. Therefore, to reduce contention on the
timestamp generator, the clocks can be separated. One clock for violations and
another for commits. Read-write transactions get their read timestamp from the
violation clock. Read transactions get their read timestamp from the commit
clock. With this separation, commits and violations don't contend when
incrementing.

## Commit Dependencies

A handy benefit of the versioned list is commit dependencies are embedded in
it. Transactions do not need to keep track of write dependents as during lock
release they will visible in the version list.

However, the write set is not necessarily the same as the read set of a
transaction. We also need to track commit dependencies for read rows. This is
because we may be reading uncommitted data. So the transaction must wait for all
read rows to be committed and abort if necessary before committing.

We can implement this using the approach from _High-Performance Concurrency
Control Mechanisms for Main-Memory Databases_.[^5]

Each transaction, `T`, will have three new fields:

* `ReadCommitDepSet`: A set of all the read transaction ids that depend on `T`.
* `CommitDepCounter`: A counter of all (read + write) transactions that `T`
  depends on.
* `AbortNow`: A boolean flag that other transactions can set to tell `T` to
  abort.

When `T` acquires an exclusive lock through controlled lock violation, it
increments its own `CommitDepCounter`. When `T` performs a controlled lock
violation for a read on another transaction, it increments its own
`CommitDepCounter`, and adds itself to the other transaction's
`ReadCommitDepSet`. It only does this for the node that is actually read (it may
have iterated through X uncommitted nodes before it).

During a commit/abort, `T` will iterate through its `ReadCommitDepSet` and
decrement the transaction's `CommitDepCounter`. During lock release, it will
also decrement the next node in the version's list `CommitDepCounter`. If it was
an abort, it additionally will set the `AbortNow` flag on all the transactions.

In the following scenario, `Txn A` has not performed any lock violations so
`CommitDepCounter = 0`. `Txn B` violated the lock and read the V2 from `Txn B`,
so it added itself to the `ReadCommitDepSet` and incremented its own
`CommitDepCounter`.

{% load_data(path="blog/artifacts/clv_mvcc_read.svg") %} Figure 13. Read
generating a commit dependency {% end %}

If the database does not support two-phase commit and does not use an out of
order log, it can be simpler to implement the read dependencies using high
watermark. There would still need to be the `CommitDepCounter` and `AbortNow`
for write dependencies unless those also participated in the use of high
watermarks.

[^5]: Per-Åke Larson, Spyros Blanas, Cristian Diaconu, Craig Freedman, Jignesh
	M. Patel, and Mike Zwilling. 2011. [High-performance concurrency control
	mechanisms for main-memory
	databases](https://www.semanticscholar.org/paper/High-Performance-Concurrency-Control-Mechanisms-for-Larson-Blanas/7ce9e2064bfe1d50ca59edecff8da40604985c0d).
	Proc. VLDB Endow. 5, 4 (December 2011),
	298–309. <https://doi.org/10.14778/2095686.2095689>

## Write Row Return

When returning rows from a single-statement write, e.g. using PostgreSQL's
Returning[^6] or Microsoft SQL Server's Output[^7] clauses, the behavior depends
on the guarantees you want to provide.

If the results are of committed writes only, the inserted rows should return
after the commit is durable as expected. If the behavior is similar to MSSQL
Server,

> An UPDATE, INSERT, or DELETE statement that has an OUTPUT clause will return
> rows to the client even if the statement encounters errors and is rolled
> back. The result shouldn't be used if any error occurs when you run the
> statement.[^7]

then it is possible to stream the results back immediately for single-statement
transactions. This is because the rows will be guaranteed to be committed if the
statement is successful, because implicit commit will resolve the commit
dependencies.

[^6]: [PostgreSQL Returning
Clause](https://www.postgresql.org/docs/current/dml-returning.html)
[^7]: [Microsoft SQL Server Output
	Clause](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql?view=sql-server-ver16)

## For Update

_For update_ queries need to acquire the exclusive lock without installing a new
value. This means it needs to be a read-write query.  My understanding of the
semantics of a _for update_ is exclusive access for the duration of the user
portion of the transaction. So, as long as the semantics are not "until the
transaction is durable", the transaction can release the lock early. Unlike
write queries, no new value is inserted so when the transaction determines its
violation timestamp, the transaction will perform a true early lock release of
its _for update_ locks.

Unlike write row return above, returning rows from a _for update_ can incur
commit dependencies that we need to resolve. Because there are no special
semantics about returning rows to the client in a _for update_ query, we need to
prevent dirty reads. See the section below on preventing dirty reads for
handling commit dependencies when returning rows to the client.

I have not put much thought into shared _for update_ queries. They require a
shared lock which changes concurrency control significantly. It is something to
think about when looking at serializability (which requires the use of shared
locks).

## Two Phase Commit

It is important that when resolving read-only sites in two-phase commit, that
commit dependencies are resolved. The transaction may have read some uncommitted
data from the read only site, and made decisions on it or inserted it into a
different site. They are dirty reads. Therefore, the prepare on the read-only
site must fail if any of the commit dependencies fail.

## Multi-Statement

Multi-statement transactions have to use read-write visibility semantics. This
is because using the `CommitTs` for reads would hide your own writes from you if
they are not at the head of the uncommitted list. Additionally, mixing the two
visibilities depending on a read/write statement would mean the transaction is
seeing two different snapshots depending on the statement type.

### Preventing Dirty Reads

This means read statements in a multi-statement may have commit dependencies
from reading dirty rows. The DBMS can operate internally on these rows without
waiting for known outcomes. However, commit dependencies must be resolved for
rows returned to the client to prevent dirty reads. The transaction needs to
wait for the uncommitted row to become a committed row.

The wait for resolution of commit dependencies should be lazily performed. Query
execution is likely to read more rows than actually returned to the user. Some
form of row tainting may be a solution here. The transaction could taint the row
with a txn id if it is uncommitted so when at the final stage of returning the
row, a check/wait can be performed. If the query engine passes through the
versioned node, then it already has access to the transaction to check/wait on.

An illustration of this is in figure 14. The query engine is processing a query
associated with `Txn B`. It wants to return `V2` to the client. But, `V2` is
associated with `Txn A` which is not yet committed so the query must wait. The
query engine will block on `Txn A` until it is committed and its rows can be
forwarded to the client.

{% load_data(path="blog/artifacts/clv_mvcc_return.svg") %} Figure 14. Returning
a row that has a commit dependency {% end %}

Of course if `Txn A` instead aborted, then `Txn B` would also abort.

A nice optimization is when returning rows that the transaction wrote, one does
not need to wait for commit dependencies. This is because the client is
expecting to receive uncommitted data. This also applies to the write row return
statement, because the write statement is not expected to commit. The rows
returned will always be uncommitted. So regardless of the guarantees
single-statement write row return provides, in the multi-statement no waiting is
necessary.

### New Multi-Statement Types

There are two new types of multi statement transactions that can be useful with
controlled lock violation.

**Read only multi-statement transactions**

Because read queries have higher overhead in read-write transactions due to
commit dependencies, having read-only multi-statement transactions would allow
for multiple read queries as of the same timestamp with zero overhead. They
would use the `CommitTs` visibility rule for all the queries which prevents
commit dependencies. As the name implies, attempting to do a write query in a
read-only multi statement would produce an error.

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

Introduce serializability

UNDONE: conclusion
