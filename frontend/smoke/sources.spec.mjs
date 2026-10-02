import { test, expect } from "@playwright/test";

const frontend =
  "https://contact-resolution-workbench-productization-v1.vercel.app";
const backend = "https://http--staging-api--t686v9g45v9c.code.run";

test("E4: public Sources, real API batches, credential lifecycle and isolation", async ({
  page,
  browser,
  request,
}) => {
  let session;
  const errors = [];
  page.on("pageerror", () => errors.push("browser error"));
  page.on("request", (req) => {
    if (
      req.url().startsWith(`${backend}/api/v1/cases`) &&
      req.headers()["x-workspace-id"]
    )
      session = req.headers();
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue with anonymous demo" })
    .click();
  await expect(page.getByText("No cases yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sources / Integrations" }),
  ).toBeVisible();
  const suffix = Date.now();
  const create = async (kind) => {
    await page.getByLabel("Source name").fill(`E4 ${kind} ${suffix}`);
    await page.getByLabel("Source type").selectOption(kind);
    const responsePromise = page.waitForResponse(
      (res) =>
        res.url() === `${backend}/api/v1/sources` &&
        res.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Create Source", exact: true })
      .click();
    const response = await responsePromise;
    const data = await response.json();
    try {
      await page.getByRole("button", { name: "Close and discard key" }).click();
    } finally {
      await page.keyboard.press("Escape");
    }
    // Assertions occur after dismissal, so failure snapshots cannot capture a credential.
    expect(response.status()).toBe(201);
    expect(Boolean(data.api_key?.startsWith("crw_src_"))).toBe(true);
    expect((await page.content()).includes(data.api_key)).toBe(false);
    expect(
      JSON.stringify(
        await page.evaluate(() => ({
          local: { ...globalThis.localStorage },
          session: { ...globalThis.sessionStorage },
        })),
      ).includes(data.api_key),
    ).toBe(false);
    const safe = await request.get(`${backend}/api/v1/sources/${data.id}`, {
      headers: session,
    });
    expect(safe.status()).toBe(200);
    expect((await safe.text()).includes(data.api_key)).toBe(false);
    return data;
  };
  const reference = await create("REFERENCE");
  const referenceRecords = [
    {
      external_record_id: "master-1",
      full_name: "Avery Meridian",
      old_email: "avery@synthetic.test",
      old_phone: "+1 202 555 0141",
      employer: "Synthetic Group",
      location: "Test City",
    },
    {
      external_record_id: "master-2",
      full_name: "Jordan Acacia",
      old_email: "jordan@synthetic.test",
      old_phone: "+1 202 555 0142",
      employer: "Synthetic Group",
      location: "Test City",
    },
    {
      external_record_id: "master-3",
      full_name: "Morgan Cypress",
      old_email: "morgan@synthetic.test",
      old_phone: "+1 202 555 0143",
      employer: "Synthetic Group",
      location: "Test City",
    },
  ];
  const send = (key, records, idempotency = "e4-batch-001") =>
    request.post(`${backend}/api/v1/source-ingestions`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "Idempotency-Key": idempotency,
      },
      data: { records },
    });
  const waitJob = async (jobId) => {
    let job;
    await expect
      .poll(
        async () => {
          const response = await request.get(
            `${backend}/api/v1/jobs/${jobId}`,
            { headers: session },
          );
          job = await response.json();
          return job.status;
        },
        { timeout: 60_000 },
      )
      .toBe("SUCCEEDED");
    expect(job.successful_rows).toBe(3);
    return job;
  };
  const referenceResponse = await send(reference.api_key, referenceRecords);
  expect(referenceResponse.status()).toBe(202);
  const referenceRun = await referenceResponse.json();
  await waitJob(referenceRun.job.id);
  const incoming = await create("INCOMING");
  const records = [
    referenceRecords[0],
    referenceRecords[1],
    { external_record_id: "unseen-1", full_name: "Zora Unseen" },
  ];
  const incomingResponse = await send(incoming.api_key, records);
  expect(incomingResponse.status()).toBe(202);
  const run = await incomingResponse.json();
  await waitJob(run.job.id);
  const retry = await send(incoming.api_key, records);
  expect(retry.status()).toBe(202);
  const reused = await retry.json();
  expect(reused.id).toBe(run.id);
  expect(reused.job.id).toBe(run.job.id);
  const conflict = await send(incoming.api_key, [
    { ...records[0], full_name: "Changed Payload" },
    ...records.slice(1),
  ]);
  expect(conflict.status()).toBe(409);
  const allCases = await (
    await request.get(`${backend}/api/v1/cases`, { headers: session })
  ).json();
  expect(allCases.length).toBe(3);
  const matched = allCases.find((row) => row.person_name === "Avery Meridian");
  expect(matched.routing_status).toBe("LIKELY_MATCH");
  const detail = await (
    await request.get(`${backend}/api/v1/cases/${matched.id}`, {
      headers: session,
    })
  ).json();
  expect(detail.source_id).toBe(incoming.id);
  expect(detail.ingestion_id).toBe(run.id);
  expect(detail.candidates[0].provider_source).toBe("WORKSPACE_REFERENCE");
  const card = page.locator("article").filter({ hasText: incoming.name });
  await expect(card.getByText(/SUCCEEDED/)).toBeVisible();
  await card.getByRole("button", { name: "View ingestion history" }).click();
  await expect(card.getByText(run.id, { exact: true })).toBeVisible();
  const rotatedResponse = await request.post(
    `${backend}/api/v1/sources/${incoming.id}/rotate`,
    { headers: session },
  );
  expect(rotatedResponse.status()).toBe(200);
  const rotated = await rotatedResponse.json();
  expect((await send(incoming.api_key, records)).status()).toBe(401);
  expect((await send(rotated.api_key, records, "rotated-batch")).status()).toBe(
    202,
  );
  const rotatedHistory = await (
    await request.get(`${backend}/api/v1/sources/${incoming.id}/ingestions`, {
      headers: session,
    })
  ).json();
  await waitJob(rotatedHistory[0].job.id);
  await card.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(card.getByText(/INCOMING .* DISABLED/)).toBeVisible();
  expect(
    (await send(rotated.api_key, records, "disabled-batch")).status(),
  ).toBe(401);
  expect(
    (
      await request.get(`${backend}/api/v1/sources/${incoming.id}/ingestions`, {
        headers: session,
      })
    ).status(),
  ).toBe(200);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    let otherSession;
    otherPage.on("request", (req) => {
      if (req.url().startsWith(`${backend}/api/v1/cases`))
        otherSession = req.headers();
    });
    await otherPage.goto(frontend);
    await otherPage
      .getByRole("button", { name: "Continue with anonymous demo" })
      .click();
    await expect(
      otherPage.getByText("No cases yet", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await request.get(`${backend}/api/v1/sources/${incoming.id}`, {
          headers: otherSession,
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.post(`${backend}/api/v1/sources/${incoming.id}/rotate`, {
          headers: otherSession,
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.get(`${backend}/api/v1/cases/${matched.id}`, {
          headers: otherSession,
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.get(`${backend}/api/v1/sources`, {
          headers: {
            ...otherSession,
            "x-workspace-id": session["x-workspace-id"],
          },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await other.close();
  }
  await page.getByRole("button", { name: "Open review queue" }).click();
  await page
    .getByRole("button")
    .filter({ hasText: matched.case_number })
    .click();
  await expect(
    page.getByRole("heading", { name: "Avery Meridian", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`External record: master-1`, { exact: true }),
  ).toBeVisible();
  expect(errors.length).toBe(0);
  console.log(
    JSON.stringify({
      milestone: "E4",
      referenceSource: reference.id,
      referenceIngestion: referenceRun.id,
      incomingSource: incoming.id,
      incomingIngestion: run.id,
      case: matched.id,
      referenceCount: 3,
      initialCases: 3,
      retry: "same ingestion/Job",
      conflict: 409,
      rotatedOldKey: 401,
      rotatedNewKey: 202,
      disabled: 401,
      isolation: "404/403",
      frontend: "Sources/history/provenance verified",
    }),
  );
});
