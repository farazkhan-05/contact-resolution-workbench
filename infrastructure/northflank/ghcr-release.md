# Manual backend image publication and release

This procedure was prepared on 10 October 2026 for source revision
`324e50b8a85bf34b9853d69db08ad1cb44b37b11`. The subsequent
[October release record](../../docs/production-release-acceptance-2026-10-11.md)
reports successful Northflank API deployment and a worker using the public GHCR
image. Deployment and runtime acceptance are user-reported; image digests were
not independently attested. Earlier migration/checkpoint initialization succeeded.
The steps below describe future deliberate releases.

## Why GHCR fits

The existing `backend/Dockerfile` and `backend` context build the shared API/Celery
image. The Northflank template uses a Combined API service and a Deployment worker
service with an internal image selector; its original pinned SHA is historical.
Push/PR CI tests the application and builds local kind images. The separate manual
publication workflow below publishes backend images to GHCR.

Northflank supports changing an existing Deployment service to an external image,
including GHCR. This avoids the worker's internal build-selection problem and needs
no additional service slot. GHCR is the simplest supported option here because
GitHub Actions can publish using its built-in repository token, with no cloud
registry account or publishing secret.

Sources: [Northflank image-source changes](https://northflank.com/docs/v1/application/run/change-deployment-source),
[Northflank GHCR credentials](https://northflank.com/docs/v1/application/run/save-registry-credentials),
[GitHub container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Workflow and permissions

`.github/workflows/publish-backend.yml` runs only through `workflow_dispatch`.
It checks out the supplied full SHA, builds the existing Dockerfile for Linux amd64,
and publishes `ghcr.io/<lowercase-owner>/<lowercase-repository>-backend:sha-<full-sha>`.
The default input is the October source revision above; select the intended full SHA
for a later release.
It adds source/revision labels at build time; application files are unchanged.

The job grants only `contents: read` and `packages: write` to `GITHUB_TOKEN`;
other token permissions are disabled. It requires no PAT, OIDC or attestation
permission for publication. Actions must be allowed by repository/organization
policy, and an existing package must grant this repository Actions write access.
The operator needs repository write access to dispatch the workflow.

Only a commit-SHA tag is pushed, with no `latest` tag. The workflow refuses an
existing tag and fails closed on an unrecognized manifest lookup error. Concurrency
serializes this workflow's runs for the same SHA. Tags are not a registry-enforced
immutability guarantee against other publishers; deploy the resulting `@sha256:...`
digest to guarantee immutable image selection. Rebuilding this Dockerfile can produce
a different digest because base-image tags are not digest-pinned.

New GHCR packages default to private. The workflow does not change visibility.
Private Northflank pulls need a separately approved GitHub username and PAT (classic)
with `read:packages`, package read access, and organization SSO authorization if
required, entered through Northflank's secure registry-credential form. Do not reuse
the ephemeral Actions token. A public package permits anonymous pulls, but making
it public requires separate explicit approval.

## Cost and deliberate release steps

GHCR container storage/bandwidth are currently free under
[GitHub's registry billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-packages).
Standard Actions runners are free for public repositories. Private repositories
consume included minutes (GitHub Free: 2,000/month); exceeding the quota may incur
charges or block execution depending on budgets. Check remaining quota before
dispatch; the job has a 30-minute timeout and no cache or artifact uploads.
See [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
This release procedure uses the existing Northflank services.

1. Select the intended full source SHA for publication. The workflow is committed
   on the default branch and requires manual dispatch; pushes do not publish images.
2. Confirm Actions/package policy, package Actions write access if already present,
   and available Actions quota. Open Actions -> Publish backend to GHCR -> Run
   workflow; select the intended workflow branch and enter the full source SHA
   selected in step 1 as `commit_sha`.
3. Require success. Record the image reference, source SHA, run URL and pushed
   sha256 digest. This is a fresh build of the same backend source, not an export
   of Northflank's existing build; their image digests need not match.
4. Obtain separate deployment authorization and establish the actual target
   environment. The existing README says these `staging` names serve the live
   portfolio; do not treat their names as proof of isolation. Retain the current
   API/worker image references and rollback configuration before changing either.
5. For a private package, configure the approved read-only GHCR credential securely
   in Northflank and restrict it to the existing project. Do not change visibility.
6. Review migration requirements against the intended database before rollout.
   The existing migration Job has a historical internal selector; do not reapply
   the provisioning template or assume publishing an image updates the Job.
   Northflank documents that Job image sources cannot be switched like services.
7. Release the Combined API using a successful Northflank build at that same
   source SHA. The October build was reported as `second-curve-2571`. In the existing worker's deployment overview, edit deployment ->
   External image, select the GHCR credential and enter
   `ghcr.io/<owner>/<repository>-backend@sha256:<recorded-digest>`.
   Preserve its runtime secret links, replica/resource settings, no public ports,
   no HTTP health probe, and command:
   `celery -A app.celery_app:celery_app worker --loglevel=info --concurrency=1`.
   Coordinate rollout to avoid leaving API and worker on different source releases.
8. Verify API release SHA, worker source label/digest, health, broker connection,
   Celery readiness, and the approved synthetic workflow acceptance. Roll back
   to recorded previous images if acceptance fails.

For future releases, verify GitHub policy/quota/package access, the intended
image digest, and migration requirements before dispatch or rollout. The October
acceptance is bounded user-reported evidence, not independent provider verification
or a guarantee of future worker memory stability.
