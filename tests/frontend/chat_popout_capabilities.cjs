const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");

const { chromium } = (() => {
    try {
        return require("playwright");
    } catch (error) {
        throw new Error(
            "Chat pop-out capability checks require the dev-only playwright package. Run npm ci first."
        );
    }
})();
const {
    PROTOCOL_VERSION,
    STORAGE_PREFIX,
    startCapabilityFixture,
} = require("./chat_popout_capability_fixture.cjs");

const WAIT_MS = 5000;

function nonce() {
    return `run-${randomUUID()}`;
}

// Browser timing is observed through the fixture state; capability checks
// should wait for a real transition instead of sleeping for a guessed delay.
async function waitFor(page, predicate, arg) {
    await page.waitForFunction(predicate, arg, { timeout: WAIT_MS, polling: 25 });
}

async function readState(page) {
    return page.evaluate(() => window.__fixture.getState());
}

async function openMain(context, baseUrl, runNonce, mode = "normal") {
    const page = await context.newPage();
    const url = new URL(baseUrl);
    url.searchParams.set("nonce", runNonce);
    url.searchParams.set("mode", mode);
    await page.goto(url.href);
    await page.evaluate(() => window.__fixture.writeStorage());
    return { page, url };
}

async function openPopup(page) {
    const popupPromise = page.waitForEvent("popup", { timeout: 2000 }).catch(() => null);
    await page.click("#btn-popout");
    return popupPromise;
}

function noBackendRequests(fixture) {
    const apiRequests = fixture.requests.filter((request) => request.url.startsWith("/api/"));
    assert.deepEqual(apiRequests, [], "the disposable fixture must never call a backend route");
}

test("loopback popup, storage partition, messaging, Web Locks and close", async (t) => {
    const fixture = await startCapabilityFixture();
    const browser = await chromium.launch({ headless: true });
    const runNonce = nonce();
    const context = await browser.newContext();
    t.after(async () => {
        await context.close();
        await browser.close();
        await fixture.close();
    });

    const { page: main, url } = await openMain(context, fixture.baseUrl, runNonce);
    assert.equal(await main.evaluate(() => window.isSecureContext), true,
        "127.0.0.1 loopback HTTP must be a secure context in Chromium");
    assert.equal(await main.locator("#secure-context").textContent(), "true");
    assert.equal(await main.evaluate(() => window.__fixture.readStorage()), runNonce);
    assert.deepEqual(await main.evaluate(() => window.__fixture.storageKeys()),
        [`${STORAGE_PREFIX}${runNonce}`], "only the unique fixture key may be written");

    const popup = await openPopup(main);
    assert.ok(popup, "a direct click must produce a popup page in the supported loopback context");
    await popup.waitForLoadState("domcontentloaded");
    await waitFor(main, () => window.__fixture.getState().popupState === "verified");

    const mainState = await readState(main);
    const popupState = await readState(popup);
    const expectedOrigin = url.origin;
    assert.equal(mainState.origin, expectedOrigin);
    assert.equal(popupState.origin, expectedOrigin);
    assert.equal(mainState.popupOpened, true);
    assert.equal(mainState.hello.origin, expectedOrigin, "hello must carry the exact origin");
    assert.equal(mainState.hello.sourceMatches, true, "hello must come from the opened popup reference");
    assert.equal(mainState.hello.version, PROTOCOL_VERSION);
    assert.equal(mainState.hello.nonce, runNonce);
    assert.equal(mainState.hello.storageValue, runNonce);
    assert.equal(mainState.focusAck.origin, expectedOrigin, "focus acknowledgement must be same-origin");
    assert.equal(mainState.focusAck.sourceMatches, true, "focus acknowledgement must come from the popup");
    assert.equal(mainState.focusAck.version, PROTOCOL_VERSION);
    assert.equal(popupState.ready.origin, expectedOrigin);
    assert.equal(popupState.ready.sourceMatches, true);
    assert.equal(popupState.ready.version, PROTOCOL_VERSION);
    assert.equal(await popup.evaluate(() => window.__fixture.readStorage()), runNonce,
        "same-context popup must see the unique storage nonce");
    assert.deepEqual(await popup.evaluate(() => window.__fixture.storageKeys()),
        [`${STORAGE_PREFIX}${runNonce}`], "popup must use only the unique fixture key");

    const isolated = await browser.newContext();
    try {
        const isolatedPage = await isolated.newPage();
        await isolatedPage.goto(url.href);
        assert.equal(await isolatedPage.evaluate(() => window.__fixture.readStorage()), null,
            "a separate browser context must not share the storage partition");
        await isolated.close();
    } catch (error) {
        await isolated.close();
        throw error;
    }

    await popup.evaluate(() => window.__fixture.sendInvalidVersion());
    await waitFor(main, () => window.__fixture.getState().rejected.some(item => item.reason === "version"));
    const versionReject = (await readState(main)).rejected.find(item => item.reason === "version");
    assert.equal(versionReject.origin, expectedOrigin);
    assert.equal(versionReject.sourceMatches, true);
    assert.equal(versionReject.version, PROTOCOL_VERSION + 1);

    const attackerPromise = main.waitForEvent("popup", { timeout: 2000 }).catch(() => null);
    await main.click("#btn-open-attacker");
    const attacker = await attackerPromise;
    if (attacker) await attacker.waitForLoadState("domcontentloaded");
    await waitFor(main, () => window.__fixture.getState().rejected.some(item => item.reason === "origin"));
    const originReject = (await readState(main)).rejected.find(item => item.reason === "origin");
    assert.notEqual(originReject.origin, expectedOrigin);
    assert.equal(originReject.sourceMatches, false);
    if (attacker) await attacker.close();

    await main.evaluate((name) => window.__fixture.acquireLock(name), `chat-popout:${runNonce}`);
    await waitFor(main, () => window.__fixture.getState().lock.status === "held");
    const held = await main.evaluate(async () => {
        const result = await window.__fixture.lockQuery();
        return result && result.held;
    });
    assert.deepEqual(held.map(lock => ({ name: lock.name, mode: lock.mode })),
        [{ name: `chat-popout:${runNonce}`, mode: "exclusive" }]);
    await popup.evaluate((name) => window.__fixture.acquireLock(name), `chat-popout:${runNonce}`);
    await waitFor(popup, async (name) => {
        if (window.__fixture.getState().lock.status !== "waiting") return false;
        const snapshot = await window.__fixture.lockQuery();
        return Boolean(snapshot?.pending?.some(lock => lock.name === name));
    }, `chat-popout:${runNonce}`);
    assert.equal((await readState(popup)).lock.status, "waiting",
        "a second same-origin page must wait for the exclusive lock");
    await main.evaluate(() => window.__fixture.releaseLock());
    await waitFor(popup, () => window.__fixture.getState().lock.status === "held");
    assert.deepEqual((await readState(popup)).lock.events, ["acquired"]);
    await popup.evaluate(() => window.__fixture.releaseLock());
    await waitFor(popup, () => window.__fixture.getState().lock.status === "released");

    await popup.close();
    await waitFor(main, () => window.__fixture.getState().popupClosedObserved);
    assert.equal((await readState(main)).popupState, "closed");
    noBackendRequests(fixture);
});

async function runFallback({ fixture, browser, mode, expected, initScript, expectedStorageValue }) {
    const context = await browser.newContext();
    if (initScript) await context.addInitScript(initScript);
    const runNonce = nonce();
    try {
        const { page } = await openMain(context, fixture.baseUrl, runNonce, mode);
        const popup = await openPopup(page);
        if (popup) {
            await popup.waitForLoadState("domcontentloaded");
            await waitFor(page, () => Boolean(window.__fixture.getState().fallback));
            await popup.close();
        } else {
            await waitFor(page, () => Boolean(window.__fixture.getState().fallback));
        }
        assert.match(await page.locator("#status").textContent(), expected);
        const state = await readState(page);
        assert.notEqual(state.popupState, "verified");
        assert.equal(state.hello, null, "a failed capability must not transfer a handshake");
        assert.equal(await page.evaluate(() => window.__fixture.readStorage()),
            expectedStorageValue === undefined ? runNonce : expectedStorageValue,
            "fallback must preserve only the synthetic source key");
    } finally {
        await context.close();
    }
}

test("Web Locks unavailable keeps the source in single-window mode", async (t) => {
    const fixture = await startCapabilityFixture();
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await fixture.close(); });
    await runFallback({
        fixture,
        browser,
        expected: /exclusive Web Locks/,
        initScript: () => {
            try {
                Object.defineProperty(Navigator.prototype, "locks", {
                    configurable: true,
                    get: () => undefined,
                });
            } catch (error) {
                Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
            }
        },
    });
    noBackendRequests(fixture);
});

test("opener unavailable keeps the source recoverable", async (t) => {
    const fixture = await startCapabilityFixture();
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await fixture.close(); });
    await runFallback({ fixture, browser, mode: "no-opener", expected: /did not complete the verified handshake/ });
    noBackendRequests(fixture);
});

test("blocked popup keeps the source recoverable", async (t) => {
    const fixture = await startCapabilityFixture();
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await fixture.close(); });
    await runFallback({
        fixture,
        browser,
        expected: /popup was blocked or no window reference/,
        initScript: () => { window.open = () => null; },
    });
    noBackendRequests(fixture);
});

test("blocked storage keeps the source in single-window mode", async (t) => {
    const fixture = await startCapabilityFixture();
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await fixture.close(); });
    await runFallback({
        fixture,
        browser,
        expected: /storage partition is unavailable/,
        expectedStorageValue: null,
        initScript: () => {
            const blocked = () => { throw new DOMException("Storage disabled", "SecurityError"); };
            Storage.prototype.setItem = blocked;
            Storage.prototype.getItem = blocked;
            Storage.prototype.removeItem = blocked;
        },
    });
    noBackendRequests(fixture);
});
