# Relative-Wallclock Version Type

This document describes the **relative-wallclock** version type, which specifies how version identifiers are formatted and interpreted for resources using wallclock-based timestamps.

## Overview

The relative-wallclock version type uses millisecond timestamps as version identifiers. These timestamps generally correspond to wall-clock time (milliseconds since the Unix epoch), but can advance beyond wall-clock time when necessary to maintain monotonicity.

## HTTP Header

The relative-wallclock version type is indicated using the `Version-Type` header:

```
Version-Type: relative-wallclock
```

## Version Format

Versions are numeric strings representing milliseconds since the Unix epoch:

```
"1768467700000"
```

Unlike some versioning schemes that include an agent/peer identifier (e.g., `"alice-1736625600000"`), relative-wallclock versions contain only the timestamp.

## Version Generation

When creating a new version, the timestamp is calculated as:

```
new_version = max(current_time_ms, current_version + random(1, 1000))
```

This ensures:

1. **Monotonicity**: Versions always increase, even if the clock drifts backward
2. **Entropy**: A small random number (between 1 and 1000) is added when the clock is behind, reducing collision probability when multiple peers write simultaneously
3. **Approximate wall-clock correspondence**: Under normal conditions, versions reflect actual time

## Comparison Procedure

When comparing two versions `a` and `b`:

1. **Compare as integers**: Parse the version strings as integers and compare numerically
2. **Larger wins**: The version with the larger numeric value is considered newer

```
"1768467701000" > "1768467700000"  (numerically larger)
```

Note: Because versions are numeric strings of potentially different lengths, comparison should be done numerically, not lexicographically. However, in practice, millisecond timestamps from the same era will have the same number of digits.

## Relationship to Merge Types

The relative-wallclock version type specifies only the *format and interpretation* of version identifiers. It does not specify how conflicts are resolved when concurrent versions exist.

Conflict resolution is handled by a **Merge Type** (specified via the `Merge-Type` header). For example, the [Arbitrary-Writer-Wins (AWW)](https://braid.org/protocol/merge-types/aww) merge type uses version comparison to deterministically select a winner.

When used together:
- `Version-Type: relative-wallclock` defines how to interpret and compare version strings
- `Merge-Type: aww` defines that the higher version wins in a conflict

## Example

```http
PUT /blob.png HTTP/1.1
Version: "1768467702000"
Version-Type: relative-wallclock
Content-Type: image/png
Merge-Type: aww
Content-Length: 34567

<binary data>
```

Response:

```http
HTTP/1.1 200 OK
Current-Version: "1768467702000"
Version-Type: relative-wallclock
```

## Properties

- **Simple**: Version identifiers are just numbers
- **Sortable**: Versions have a natural total ordering
- **Distributed**: No coordination required between peers to generate versions
- **Approximate causality**: Generally reflects wall-clock time, providing rough temporal ordering
- **Collision-resistant**: Random entropy reduces concurrent write collisions

## Security Considerations

- **Clock manipulation**: A malicious peer could set their clock far in the future to generate versions that always win. Systems should consider rate-limiting or rejecting versions too far in the future.
- **No authentication**: Version identifiers do not encode who created them. Authentication should be handled at a different layer.

## References

- [HTTP Resource Versioning](https://github.com/braid-org/braid-spec/blob/master/draft-toomim-httpbis-versions-03.txt)
- [Merge Types](https://github.com/braid-org/braid-spec/blob/master/draft-toomim-httpbis-merge-types-00.txt)
- [Arbitrary-Writer-Wins Merge Type](https://braid.org/protocol/merge-types/aww)
