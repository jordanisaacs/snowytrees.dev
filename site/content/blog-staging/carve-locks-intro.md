+++
title = "Efficient Serializability with Carve Locking"
date = 2026-02-10

[taxonomies]
series=[]
tags=[]

[extra]
noindex = true
+++

# Why Pessimistic Serializability?

TODO: A better hook.

Highly concurrent and efficient serializability using pessimistic concurrency
control.

# How do Carve Locks work?

Carve Locks extend ideas from _Precision Locks_[^1], _Deferred Lock
Enforcement_[^2], _Controlled Lock Violation_[^3], and embedded locks in
multi-versioning.

## Write Locks

The "write locking" within Carve Locks looks like traditional multi-versioned
locking. An uncommitted object in the multi-version list represents the
acquisition of the exclusive write lock. Lock states are represented by the
transaction state. This means unlocking the write locks is as simple as
resolving the transaction: committing or aborting.

Carve Locks' write locking also use the ideas from _Controlled Lock Violation_
by adding a `Committing` state to the transaction. After a transaction's
execution phase is complete, but before it is durable, a transaction moves from
`Active -> Committing` (not `Committed`). While in the `Committing` state, other
transactions can **violate** the write lock. Those transactions will gain a
dependency on the violated transaction and cannot commit until the violated
transaction commits, but in return they can continue execution. This can be
thought of as making transactions' writes visible immediately after execution
but before durability. A transaction in the `Committing` state cannot abort
except for a database crash which holds because the `Committing` phase is
performing durability (and resolving dependencies). Resolving dependencies has
subtlety for aborts and reads which is detailed in the deadlock detection but
requires understanding how read locking works.  Two-phase commit is left as
future work. Letting transactions continue execution allows pipelined execution
of transactions that would traditionally block on each other. More details on
the benefits can be found in the original _Controlled Lock Violation_ paper.

Because there are traditional write-locks, there will be write-write conflicts, at which point you can apply the techniques from my previous post on [holding locks across write-write conflicts](https://snowytrees.dev/blog/bounding-write-write-conflict-retries/).

## Read Dependencies

While the write locking in Carve Locks' is traditional and nothing novel, its when they are combined with my new take on precision locking that things get interesting.

### Precision Locking Background

Starting with a quick recap of the original _Precision Locking_. Precision Locking
works by having two lists:

- **L_p** = list of active predicates (what is being reading)
- **L_u** = list of in-progress writes

All reads check their predicate against the list of writes, **L_u** and if any
writes satisfy the predicate, the read blocks until the write is resolved. All
writes check if any active predicates in **L_p** evaluate to true for the write,
and blocks until there are no active predicates that evaluate to true.

This gives serializability because no writes can be written if there is a reader, and no reader can start if there are active writes. Which results in a serial order.

### Multi-Versioned Predicates

The key innovation of Carve Locks is to apply multi-versioning, _Deferred Lock Enforcement_, and
_Controlled Lock Violation_ to _Precision Locks_ so the amount of blocking is
minimal. This is achieved by giving timestamps to predicates and visibility.
When a transaction wants to perform a new read it will get its traditional
snapshot read timestamp, and then also register the predicate being used in the
"active predicates" list with that timestamp, known as `PredicateTs`. The
registration of the predicate and its assignment of a `PredicateTs` must be
performed atomically as the predicate needs a point in time in relation to write
visibility. Transactions get a `CommittingTs` timestamp from the same clock when
moving from `Active`->`Committing`.

### Transaction Dependencies

When a write transaction commits, it checks if its writes conflict with any
predicates that are `PredicateTs < CommittingTs`. The write transaction will
take a dependency on all transactions that own the conflicting predicates. This
is similar to the **L_p** check in _Precision Locking_ but moved towards the end
of a transaction's execution. This is possible because of multi-versioning the
predicates. There will be no more conflicting predicates possible, and any
future predicates will see the transaction's writes and take their own
dependency. The write transaction is guaranteed to succeed (see deadlock
detection below) thus it can make its writes durable and return `Committed` to
the user. But, internally if dependencies were taken it will go from `Committing
-> CommittedWithDependencies`.

This can be thought of a multi-versioning the "future". There is only ever a
single `Committed` value per-object, with a version list of objects that are
`Committing` or `CommittedWithDependencies`. Dependencies cannot be garbage collected until
all the active predicates that made the dependency are resolved. At which point the value goes from `Committed->CommittedWithDependencies` and the previous `Committed` value is guaranteed to never be read. This multi-versioning of the future is what
allows transactions to continue execution and only block when attempting to
commit.

For an object to be visible it must be `Committed` or the `PredicateTs >
CommittingTs`. When `PredicateTs > CommittingTs` a dependency will be
taken. This serves the role of the **L_u** check, but it is lazy
blocking. Instead blocking on a "lock", a dependency is taken on the committing
transaction. The reader cannot return any `Committing` values to the client (or
commit its own transaction) until the dependent transactions become
durable. This is for crash recovery where an external user would have seen
non-durable data on a crash. Or in a dependent transaction chain `A->B->C`, if
`C` become durable before `B`, that would be a violation of serializability. Any
`Active` transactions are also not visible as there is the guarantee that when
it does get a `CommittingTs`, the `CommittingTs > PredicateTs`. During execution
a writer does not block any readers, and during the committing phase, it lazily
blocks the reader which is required to create the durable serializable order. It
is similar to an _Update_ lock, which don't block readers from progressing until
the end of a transaction. A transaction can't commit until any in-progress
writes it saw commit.

### Dependency Deadlock Detection

The deadlock detector plays an integral role of detecting read-write
conflicts. Because there is no real "read locking", the following scenario is
possible:

1. Txn A reads `PredicateTs: 10; X > 0`.
2. Txn B writes `Insert X=10`.
3. Txn B moves to `CommittingTs: 11`, sees Txn A has a predicate on `X > 0` so
   takes a wait dependency.
4. Txn A reads `PredicateTs: 12; X > 0`. It sees Txn B's `Insert X=10`. This
   breaks repeatable reads (there is no "traditional" read lock). But there is
   no correctness issue here because the value won't be returned to the client,
   Txn B is still `Committing`. When Txn A takes its dependency on Txn B a
   deadlock is produced. Txn B depends on Txn A committing, while Txn A depends on Txn
   B committing - a deadlock!

Without a deadlock detector seemingly simple reads will quickly deadlock. Carve
Locks must abort the non-`Committing` transaction (in this case Txn A) to avoid any
cascading aborts due to _Controlled Lock Violation_ dependencies. Aborting Txn A
is also required for correctness for performing durability before resolving
predicate conflicts because Txn B if fully logged would be aborted but then come
back on recovery.

Carve Locks have the drawbacks of having higher abort rates for read
transactions that register predicates one after another instead of upfront, also
known as interactive transactions, as they bias towards allow writes to
progress. There is no real "read lock".

# Granularity of predicate based concurrency control

Because Carve Locks are still predicate based, we still get the optimal amount
of concurrency. Any value that does not fall within the predicate is not going
to be part of the conflict graph. Additionally, it enables easy implementation
of column-level concurrency. Writes can indicate which columns are being updated
to allow for column-level write concurrency. And the read predicates can
indicate which columns are being read/evaluated for column-level read
concurrency.

[^1]: J. R. Jordan, J. Banerjee, and R. B. Batman. 1981. Precision locks. In
    Proceedings of the 1981 ACM SIGMOD international conference on Management of
    data (SIGMOD '81). Association for Computing Machinery, New York, NY, USA,
    143–147. https://doi.org/10.1145/582318.582340
[^2]: Graefe, G. (2019). Deferred Lock Enforcement. In: On Transactional
    Concurrency Control. Synthesis Lectures on Data Management. Springer,
    Cham. https://doi.org/10.1007/978-3-031-01873-2_12
[^3]: Goetz Graefe, Mark Lillibridge, Harumi Kuno, Joseph Tucek, and Alistair
    Veitch. 2013. Controlled lock violation. In Proceedings of the 2013 ACM
    SIGMOD International Conference on Management of Data (SIGMOD
    '13). Association for Computing Machinery, New York, NY, USA,
    85–96. https://doi.org/10.1145/2463676.2465325
