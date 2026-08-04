Base: task/TASK-0064 (2ab1b249b30ec2e756231750e16e432a3b862507)
Lifecycle fix integrated from TASK-0065.
Resume/stop fix commit: c26c9e8

Changes:
- Save the verified resume document link before starting the download.
- Use the direct worker download path; do not open a resume tab during normal collection.
- Bound viewer/link waits and worker-message waits.
- Limit optional resume metadata scrolling to three short steps.
- Keep the applicant run lifecycle protected from stale duplicate restarts.

Validation:
- TypeScript passed.
- Production build passed.
- 415/415 tests passed.
- Build validator passed.
- Source and dist applicants.js SHA-256 match.
