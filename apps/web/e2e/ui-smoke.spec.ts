import { expect, test } from "@playwright/test";

const routes = ["/", "/overview", "/protection", "/risk", "/activity", "/settings", "/operations"];

test("all product routes render without browser errors or horizontal overflow", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  for (const route of routes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await page.waitForTimeout(route === "/overview" || route === "/operations" ? 1_200 : 300);
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    if (route === "/operations") {
      await expect(page.getByText("LIVE MAINNET EXECUTION: DISABLED")).toBeVisible();
      await expect(page.getByText(/Invalid URL/)).toHaveCount(0);
    }
  }

  expect(browserErrors).toEqual([]);
});

test("landing story scrolls through every protection stage", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Your position. Protected before liquidation." })).toBeVisible();
  await expect(page.getByText("ILLUSTRATIVE - NOT LIVE DATA")).toBeVisible();

  await page.getByRole("link", { name: "See how it works" }).click();
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(page.getByRole("heading", { name: "Five deliberate stages. One bounded outcome." })).toBeVisible();

  for (const selector of ["#protection", ".simulation-story", "#evidence", ".landing-closing"]) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
  }

  const hiddenItems = await page.locator("[data-stagger-item]").evaluateAll((items) =>
    items.filter((item) => getComputedStyle(item).visibility !== "visible" || Number(getComputedStyle(item).opacity) < 0.95).length,
  );
  expect(hiddenItems).toBe(0);
  await expect(page.getByRole("heading", { name: "Protect the position before the market makes the decision." })).toBeVisible();
});

test("overview presents verified live data or a fail-closed state with expandable evidence", async ({ page }) => {
  const currentResponse = await page.request.get("/api/live/current");
  expect(currentResponse.status()).toBe(200);
  const current = await currentResponse.json() as {
    mode: string;
    status: string;
    risk: { classification: string | null };
    snapshot: unknown | null;
    envelope: { status: string; snapshot: unknown | null };
    broadcastPermitted: boolean;
    transactionSubmitted: boolean;
  };
  expect(current.mode).toBe("LIVE_READ_ONLY");
  expect(current.broadcastPermitted).toBe(false);
  expect(current.transactionSubmitted).toBe(false);

  if (current.status === "COMPLETE") {
    expect(current.envelope.status).toBe("AVAILABLE");
    expect(current.snapshot).not.toBeNull();
    expect(current.envelope.snapshot).not.toBeNull();
    expect(current.risk.classification).not.toBeNull();
  } else {
    expect(current.status).toBe("UNAVAILABLE");
    expect(current.envelope.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(current.snapshot).toBeNull();
    expect(current.envelope.snapshot).toBeNull();
    expect(current.risk.classification).toBeNull();
  }

  await page.goto("/overview", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Current protection state")).toBeVisible();
  await expect(page.getByText("PREVIEW ONLY / NO TRANSACTION SUBMITTED")).toBeVisible();
  await page.locator(".risk-signal-section").scrollIntoViewIfNeeded();
  await page.waitForTimeout(550);

  const signals = page.locator(".risk-signal-card");
  await expect(signals).toHaveCount(6);
  await signals.first().locator("summary").click();
  await expect(signals.first()).toHaveAttribute("open", "");

  const liveActions = page.locator(".live-overview-actions");
  const liveStatus = liveActions.getByText("LIVE DATA AVAILABLE", { exact: true });
  const unavailableStatus = liveActions.getByText("DATA UNAVAILABLE", { exact: true });
  await expect(liveStatus.or(unavailableStatus)).toHaveCount(1);
  if (await liveStatus.isVisible()) {
    await expect(page.getByText("SNAPSHOT COMPLETE", { exact: true })).toBeVisible();
    await expect(page.getByText("No backing-risk state is inferred from incomplete data.")).toHaveCount(0);
  } else {
    await expect(page.getByText("INCOMPLETE DATA", { exact: true })).toBeVisible();
    await expect(page.getByText("No backing-risk state is inferred from incomplete data.")).toBeVisible();
  }
});

test("wallet controls fail safely without an injected browser wallet", async ({ page }) => {
  await page.goto("/protection", { waitUntil: "networkidle" });
  const connect = page.getByRole("button", { name: "Connect wallet" }).first();
  await expect(connect).toBeEnabled();
  await page.waitForTimeout(250);
  await connect.click();
  await expect(page.getByText("No browser wallet detected").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve bounded allowance" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Register protection" })).toBeDisabled();
});

test("keyboard focus is visible and reaches primary navigation", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const firstLink = page.locator(".landing-nav-v2 .brand");
  await firstLink.waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  await page.keyboard.press("Tab");
  await expect(firstLink).toBeFocused();
  const outline = await firstLink.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Tab");
  const moved = await page.evaluate(() => document.activeElement !== document.querySelector(".landing-nav-v2 .brand"));
  expect(moved).toBe(true);
  await expect(page.locator(":focus")).toBeVisible();
});

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("keeps the story visible without decorative transforms", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const reveal = page.locator(".landing-statement .motion-reveal");
    const styles = await reveal.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      visibility: getComputedStyle(element).visibility,
      transform: getComputedStyle(element).transform,
    }));
    expect(styles).toEqual({ opacity: "1", visibility: "visible", transform: "none" });
  });
});
