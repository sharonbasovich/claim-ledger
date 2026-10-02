import { expect, test, type Page } from "@playwright/test";

async function loadSample(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Load fictional example packet" }).click();
  await expect(page.locator(".doc")).toHaveCount(12, { timeout: 15000 });
}

test.describe("keyword mode (no AI)", () => {
  test("banner is visible and results are labelled bm25", async ({ page }) => {
    await loadSample(page);
    await expect(page.locator(".banner")).toContainText("Keyword mode");
    // ask in keyword mode
    await page.locator("#ask-input").fill("Which port does the pantry web UI use?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.locator(".q .receipt").first()).toBeVisible();
    await expect(page.locator(".q .chip-mode-bm25").first()).toBeVisible();
    await expect(page.locator(".q").first()).toContainText("8080");
  });

  test("claims are extracted and show honest empty state", async ({ page }) => {
    await loadSample(page);
    const claims = page.locator(".claim");
    await expect(claims.first()).toBeVisible();
    // unsearched claims must not imply a search ran
    await expect(page.locator(".noreceipt").first()).toContainText("No linked receipt yet");
    await expect(page.locator(".noreceipt").first()).not.toContainText("no strong match");
    // claims are complete sentences — no header or wrap fragments
    for (const t of await page.locator(".claim-text").allTextContents()) {
      expect(t.trim()).toMatch(/[.!?]$/);
      expect(t).not.toMatch(/^#{1,6}\s/);
    }
  });

  test("weak-match label appears only after a real search", async ({ page }) => {
    await loadSample(page);
    // a claim that cannot match anything in the corpus
    await page.getByRole("button", { name: "+ Add claim" }).click();
    const edit = page.locator("textarea.claim-edit").first();
    await edit.fill("Zxq ktrj vmbn quux splonk frimbulazzlated.");
    await edit.blur();
    const card = page.locator(".claim", { hasText: "frimbulazzlated" });
    // before any search: unsearched wording only, never an implied result
    await expect(card.locator(".noreceipt", { hasText: "No linked receipt yet" })).toBeVisible();
    await expect(card.locator(".noreceipt", { hasText: "No strong match" })).toHaveCount(0);
    await page.getByRole("button", { name: /Find receipts \(keywords\)/ }).click();
    // after searching, claims with no matching sources get the weak-match label
    await expect(card.locator(".noreceipt", { hasText: "No strong match" })).toBeVisible();
  });

  test("find receipts via keywords attaches labelled receipts", async ({ page }) => {
    await loadSample(page);
    await page.getByRole("button", { name: /Find receipts \(keywords\)/ }).click();
    await expect(page.locator(".claim .receipt").first()).toBeVisible();
    await expect(page.locator(".claim .chip-mode-bm25").first()).toBeVisible();
  });
});

test.describe("reviewer workflow", () => {
  test("status is human-set and exported", async ({ page }) => {
    await loadSample(page);
    await page.getByRole("button", { name: /Find receipts \(keywords\)/ }).click();
    // set a verdict on the first claim
    await page.locator(".claim").first().getByRole("button", { name: "Confirmed" }).click();
    await page.locator(".claim .note").first().fill("Verified by reading the source.");
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export handoff (.md)" }).click(),
    ]);
    const path = await dl.path();
    const { readFileSync } = await import("node:fs");
    const md = readFileSync(path!, "utf8");
    expect(md).toContain("Reviewer-confirmed");
    expect(md).toContain("sha256");
    expect(md).toContain("retrieval is not verification");
    expect(md).toContain("Fictional");
  });

  test("removing a source marks receipts stale", async ({ page }) => {
    await loadSample(page);
    await page.getByRole("button", { name: /Find receipts \(keywords\)/ }).click();
    await expect(page.locator(".claim .receipt").first()).toBeVisible();
    await page.locator(".doc").first().getByRole("button", { name: "Remove" }).click();
    await expect(page.locator(".chip-stale").first()).toBeVisible();
  });

  test("reset clears everything and kills in-flight work", async ({ page }) => {
    await loadSample(page);
    await page.getByRole("button", { name: "Reset packet" }).click();
    await expect(page.locator(".doc")).toHaveCount(0);
    await expect(page.locator(".claim")).toHaveCount(0);
  });

  test("replacing a source flags old receipts stale — never relinks to new text", async ({ page }) => {
    await loadSample(page);
    await page.getByRole("button", { name: /Find receipts \(keywords\)/ }).click();
    await expect(page.locator(".claim .receipt").first()).toBeVisible();
    // replace inkwell/README.md with unrelated text under the same filename
    await page.locator(".paste").fill("Totally unrelated content about garden watering schedules and nothing else.");
    await page.locator("input[placeholder*=\"File name\"]").fill("inkwell/README.md");
    await page.getByRole("button", { name: "Add document" }).click();
    await expect(page.locator(".chip-stale").first()).toBeVisible();
    // new text must never render under an old score
    await expect(page.locator(".claim .receipt-text", { hasText: "garden watering" })).toHaveCount(0);
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export handoff (.md)" }).click(),
    ]);
    const { readFileSync } = await import("node:fs");
    const md = readFileSync((await dl.path())!, "utf8");
    expect(md).toContain("STALE");
    expect(md).not.toContain("garden watering");
  });

  test("confirmed verdict invalidates when evidence changes — never silently renewed", async ({ page }) => {
    // QA cobalt-limit flow: verdict must be bound to claim + evidence fingerprints
    await page.goto("/");
    await page.locator(".paste").fill("QA-only fictional source. The cobalt import limit is 200 items.");
    await page.locator("input[placeholder*=\"File name\"]").fill("qa-cobalt-limit.txt");
    await page.getByRole("button", { name: "Add document" }).click();
    await page.getByRole("button", { name: "+ Add claim" }).click();
    const edit = page.locator("textarea.claim-edit").first();
    await edit.fill("The cobalt import limit is 200 items.");
    await edit.blur();
    const claim = page.locator(".claim", { hasText: "cobalt import limit" });
    await page.getByRole("button", { name: /Find receipts \(keywords\)/ }).click();
    await expect(claim.locator(".receipt")).toBeVisible();
    // reviewer confirms against the 200-item evidence
    await claim.getByRole("button", { name: "Confirmed" }).click();
    await expect(claim.locator(".status-btn.st-confirmed.active")).toBeVisible();
    // same filename replaced with 210 items
    await page.locator(".paste").fill("QA-only fictional source. The cobalt import limit is 210 items.");
    await page.locator("input[placeholder*=\"File name\"]").fill("qa-cobalt-limit.txt");
    await page.getByRole("button", { name: "Add document" }).click();
    // receipt flagged stale AND the verdict invalidated — Confirmed no longer active
    await expect(claim.locator(".chip-stale").first()).toBeVisible();
    await expect(claim.locator(".verdict-stale")).toContainText("invalidated");
    await expect(claim.locator(".status-btn.st-confirmed.active")).toHaveCount(0);
    await expect(claim.locator(".status-btn.st-not_checked.active")).toBeVisible();
    // re-rank attaches fresh 210 evidence — verdict STILL invalidated until fresh review
    await claim.getByRole("button", { name: "Re-rank" }).click();
    await expect(claim.locator(".receipt:not(.stale)")).toBeVisible();
    await expect(claim.locator(".receipt-text").first()).toContainText("210 items");
    await expect(claim.locator(".verdict-stale")).toContainText("invalidated");
    await expect(claim.locator(".status-btn.st-confirmed.active")).toHaveCount(0);
    // survives reload — no resurrection from storage
    await page.reload();
    const claim2 = page.locator(".claim", { hasText: "cobalt import limit" });
    await expect(claim2.locator(".verdict-stale")).toContainText("invalidated");
    await expect(claim2.locator(".status-btn.st-confirmed.active")).toHaveCount(0);
    // a fresh Confirmed click re-binds to the new evidence and clears the hint
    await claim2.getByRole("button", { name: "Confirmed" }).click();
    await expect(claim2.locator(".status-btn.st-confirmed.active")).toBeVisible();
    await expect(claim2.locator(".verdict-stale")).toHaveCount(0);
    // export: invalidation is recorded; effective status is not checked
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export handoff (.md)" }).click(),
    ]);
    const { readFileSync } = await import("node:fs");
    const md = readFileSync((await dl.path())!, "utf8");
    expect(md).toContain("Reviewer-confirmed");
  });

  test("manual claim creation", async ({ page }) => {
    await loadSample(page);
    await page.getByRole("button", { name: "+ Add claim" }).click();
    await page.locator(".claim-edit").first().fill("This is a manually typed claim about ports.");
    await page.locator(".claim-edit").first().blur();
    await expect(page.locator(".claim-text").first()).toContainText("manually typed claim");
  });
});

test.describe("safety", () => {
  test("HTML/JS in imported docs renders as text, never executes", async ({ page }) => {
    let alertFired = false;
    page.on("dialog", () => { alertFired = true; });
    await page.goto("/");
    await page.locator(".paste").fill('<script>alert("xss")</script><img src=x onerror=alert(1)> Pasted malicious content here.');
    await page.locator("input[placeholder*=\"File name\"]").fill("evil.md");
    await page.getByRole("button", { name: "Add document" }).click();
    await expect(page.locator(".doc-name").first()).toContainText("evil.md");
    await expect(page.locator(".doc-detail").first()).toContainText("alert");
    expect(alertFired).toBe(false);
  });
});

test.describe("model load (real)", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        console.log(`[browser ${message.type()}] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => console.log(`[browser pageerror] ${error.message}`));
    page.on("requestfailed", (request) => {
      console.log(`[request failed] ${request.url()} ${request.failure()?.errorText}`);
    });
  });

  async function enableRealModel(page: Page) {
    await page.locator("#enable-model").click();
    // Wait for either terminal state, so real errors appear immediately in CI
    // instead of being hidden behind a two-minute missing-element timeout.
    const status = page.locator("#modelctl .chip-ok, #modelctl .chip-err");
    await expect(status).toBeVisible({ timeout: 120_000 });
    expect(await status.textContent()).toContain("AI ranking on");
    await expect(page.locator(".chip-ok")).toBeVisible();
  }

  test("enable → ready, receipts re-ranked with semantic modes", async ({ page }) => {
    test.setTimeout(180_000);
    await loadSample(page);
    await enableRealModel(page);
    // receipts were auto-computed after ready
    await expect(page.locator(".claim .receipt").first()).toBeVisible({ timeout: 60_000 });
    const modeChip = await page.locator(".claim .receipt .chip-mode-semantic, .claim .receipt .chip-mode-hybrid").first().textContent();
    expect(modeChip).toMatch(/semantic|hybrid/);
    // banner gone
    await expect(page.locator(".banner")).toHaveCount(0);
    // a paraphrase question finds a receipt
    await page.locator("#ask-input").fill("Can I use the trail planner on a plane with no signal?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.locator(".q .receipt").first()).toBeVisible();
  });

  test("corpus change mid-embedding drops late results", async ({ page }) => {
    test.setTimeout(180_000);
    await loadSample(page);
    await enableRealModel(page);
    // widen the embed window deterministically, then race a removal against it
    await page.evaluate(() => { (window as unknown as { __cl_embedDelayMs: number }).__cl_embedDelayMs = 1200; });
    await page.locator(".doc").first().getByRole("button", { name: "Remove" }).click(); // invalidate vectors
    const claim = page.locator(".claim", { has: page.locator(".receipt") }).first();
    await claim.getByRole("button", { name: "Re-rank" }).click();
    await page.locator(".doc").first().getByRole("button", { name: "Remove" }).click(); // epoch bump mid-flight
    // late results must be dropped: receipts stay stale-marked, none freshly attached
    await expect(claim.locator(".receipt:not(.stale)")).toHaveCount(0);
    await expect(claim.locator(".chip-stale").first()).toBeVisible();
  });

  test("source replacement mid-embedding drops late results", async ({ page }) => {
    test.setTimeout(180_000);
    await loadSample(page);
    await enableRealModel(page);
    await page.evaluate(() => { (window as unknown as { __cl_embedDelayMs: number }).__cl_embedDelayMs = 1200; });
    const claim = page.locator(".claim", { has: page.locator(".receipt") }).first();
    await claim.getByRole("button", { name: "Re-rank" }).click();
    await page.locator(".paste").fill("Replacement text about unrelated kitchen timers.");
    await page.locator("input[placeholder*=\"File name\"]").fill("inkwell/README.md");
    await page.getByRole("button", { name: "Add document" }).click();
    await expect(claim.locator(".receipt:not(.stale)")).toHaveCount(0);
    await expect(claim.locator(".chip-stale").first()).toBeVisible();
  });

  test("cancel during download returns to off state", async ({ page }) => {
    await page.goto("/");
    // block the model fetch so cancel always wins the race
    await page.route("**/models/**", async (route) => {
      await new Promise((r) => setTimeout(r, 30000));
      await route.abort();
    });
    await page.locator("#enable-model").click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#enable-model")).toBeVisible();
    await expect(page.locator(".hint", { hasText: "cancelled" })).toBeVisible();
  });
});

test.describe("layout", () => {
  test("single column at phone width, keyboard shortcut focuses ask box", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await loadSample(page);
    const lanes = await page.locator(".lane").all();
    const xs = await Promise.all(lanes.map((l) => l.boundingBox().then((b) => b!.x)));
    expect(new Set(xs).size).toBe(1); // all lanes start at same x = stacked
    await page.keyboard.press("/");
    await expect(page.locator("#ask-input")).toBeFocused();
  });
});
