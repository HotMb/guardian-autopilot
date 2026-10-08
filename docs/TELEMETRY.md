# Telemetry and team reporting foundation

`src/telemetry.ts` provides a local contract for future opt-in reporting:

- consent is `off` by default at the integration boundary;
- the anonymous event contains only counts, bytes, errors, findings, and optional duration;
- paths, filenames, hashes, source text, repository names, and identities are not accepted in the event shape;
- aggregation is deterministic and contains no user or repository identifier;
- retention defaults to 30 days and is bounded to a maximum of 3650 days.

This repository does not upload telemetry, create accounts, retain a cloud database, or expose a team dashboard. A future hosted implementation must obtain explicit consent, document retention and deletion behavior, and keep source upload disabled unless separately authorized.
