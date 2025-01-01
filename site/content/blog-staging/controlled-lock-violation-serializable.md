+++
title = "Controlled Lock Violation w/ Multi-Versioned Concurrency Control for Serializability"
date = 2024-12-30

[taxonomies]
series=[]
tags=[]

[extra]
noindex = true
+++

## Serializable Isolation

In serializable, one also to check read-write conflicts. There needs to be
shared locks (reads) in addition to exclusive locks.

### Multi-statement

In serializable, it is possible for a subsequent transaction to do
writes. Therefore, all queries in the multi-statement have to be treated as
read-writes.

It might make sense to have a ~read-only multi-statement~ transaction in
serializable that locks down write transactions. Then, reads in the
multi-statement require no locking. It is equivalent to running multiple read
queries as-of the same timestamp.

these differ from commit dependencies. Completion
dependencies only must wait for a known outcome of dependent transactions, while
commit dependencies must abort if any dependent
transaction aborts. Completion dependencies are required because of Case 3
mentioned earlier, a row cannot be returned to the client until there is a known
outcome of all the uncommitted data (excluding the transaction's own writes).

# Reads

Serializable reads do not need to be done at a read timestamp due to read locks. Just perform everything at the latest committed node. Do get a timestamp to determine where in the uncommitted node list you can acquire a lock?

Snapshot reads are not serializable

https://www.cs.umb.edu/~poneil/ROAnom.pdf
