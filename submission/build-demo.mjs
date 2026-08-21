import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.EGRESS_DEMO_BASE_URL ?? "https://egress-opal.vercel.app";
const root = process.cwd();
const workDir = join(tmpdir(), "egress-demo-build");
const outputVideo = process.env.EGRESS_DEMO_OUTPUT ?? join(tmpdir(), "egress-demo.mp4");
const outputSrt = join(root, "submission", "egress-demo.srt");
const edgeTts = process.env.EDGE_TTS_BIN ?? "edge-tts";
const chromiumPath = process.env.CHROMIUM_PATH;
const voice = process.env.EDGE_TTS_VOICE ?? "en-US-ChristopherNeural";
const titleFont = process.env.EGRESS_DEMO_FONT_PATH
  ? `fontfile=${process.env.EGRESS_DEMO_FONT_PATH}`
  : "font='DejaVu Sans'";
const monoFont = process.env.EGRESS_DEMO_MONO_FONT_PATH
  ? `fontfile=${process.env.EGRESS_DEMO_MONO_FONT_PATH}`
  : "font='DejaVu Sans Mono'";

const scenes = [
  {
    id: "title",
    kind: "title",
    title: "EGRESS",
    subtitle: "A policy-bounded circuit breaker for X Layer DeFi risk",
    blocks: [
      "This is Egress: a policy-bounded circuit breaker for xBETH-backed xETH debt on Aave X Layer.",
    ],
  },
  {
    id: "problem",
    kind: "landing",
    blocks: [
      "The problem is not only seeing liquidation risk.",
      "It is responding early without giving an automated process arbitrary control over a user's position.",
      "Egress watches backing and redemption evidence, Aave health, oracle freshness, and executable liquidity.",
      "It then moves through detection, deterministic validation, and simulation before any supported write path.",
    ],
  },
  {
    id: "live",
    kind: "overview-live",
    blocks: [
      "Now I am opening the live console.",
      "This view reads X Layer mainnet, chain 196, from a block-pinned archive.",
      "It is not a screenshot or a fabricated fixture.",
      "The current record exposes the observed block, snapshot status, and health factor.",
      "It also shows xBETH collateral, xETH debt, executable liquidity, and evidence-backed risk.",
    ],
  },
  {
    id: "risk",
    kind: "overview-evidence",
    blocks: [
      "The current observation is LOW risk, but the health factor is already below the configured protection boundary.",
      "That is a real state, not a forced demo alarm.",
      "Egress keeps those signals separate instead of inventing a crisis classification.",
      "The six checks show what Egress watches.",
      "Those are xBETH backing, Aave health, executable liquidity, oracle freshness, policy readiness, and simulation.",
    ],
  },
  {
    id: "policy",
    kind: "overview-preview",
    blocks: [
      "The protection preview is deterministic.",
      "AI may help interpret a source revision.",
      "But it cannot choose an arbitrary token, amount, slippage limit, or contract.",
      "Those values are checked against the policy.",
      "In this real snapshot, the risk trigger and post-action health floor are not both satisfied.",
      "The policy rejects the proposed path, even though the health boundary is active.",
      "That refusal is the safety behavior.",
      "No risk is fabricated just to make a demo look active.",
    ],
  },
  {
    id: "boundary",
    kind: "operations",
    blocks: [
      "This production environment is intentionally read-only.",
      "The preview is not a transaction.",
      "Broadcast is disabled, transaction submitted is false, and execution staging is disabled.",
      "The operations page exposes database, archive, poller, RPC, oracle, indexed block, and lag.",
      "It states the hard boundary plainly: live mainnet execution is disabled.",
    ],
  },
  {
    id: "historical",
    kind: "phase11",
    blocks: [
      "For historical proof, I open the Phase 11 panel.",
      "This is X Layer testnet, chain 1952, not mainnet.",
      "Twenty-six of twenty-six records are safe-canonical and finalized-canonical under the publication policy.",
      "The panel exposes the deployment anchor, runtime verification, re-included sequences, and content hashes.",
      "This proves the execution architecture was exercised historically.",
      "It does not claim that the current mainnet observer executed anything.",
    ],
  },
  {
    id: "closing",
    kind: "closing",
    title: "OBSERVE. VALIDATE. PROVE.",
    subtitle: "Live mainnet observation with a deliberate no-broadcast boundary",
    blocks: [
      "The complete architecture begins with live observation and evidence-backed detection.",
      "It continues through deterministic validation, bounded simulation, and user-controlled authorization.",
      "An auditable boundary remains before any supported write path.",
      "Egress protects the decision before the market makes it.",
      "The public demo is at egress-opal.vercel.app.",
      "The implementation and historical evidence are on GitHub.",
    ],
  },
];

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function probe(path) {
  return Number(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ], { encoding: "utf8" }).trim());
}

function stamp(seconds) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const whole = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function makeTitleCard(scene, duration, output) {
  const titlePath = join(workDir, `${scene.id}-title.txt`);
  const subtitlePath = join(workDir, `${scene.id}-subtitle.txt`);
  writeFileSync(titlePath, scene.title);
  writeFileSync(subtitlePath, scene.subtitle);
  const filter = [
    `drawtext=${titleFont}:textfile=${titlePath}:fontcolor=0xfff7f4:fontsize=74:x=120:y=390:line_spacing=12`,
    `drawtext=${titleFont}:textfile=${subtitlePath}:fontcolor=0x8de6df:fontsize=27:x=124:y=500:line_spacing=8`,
    `drawtext=${monoFont}:text='LIVE READ-ONLY DEMO':fontcolor=0x84999d:fontsize=18:x=124:y=570`,
  ].join(",");
  run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=0x050c10:s=1920x1080:d=${duration}`,
    "-vf", filter,
    "-r", "30", "-t", String(duration),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    output,
  ]);
}

function concatAudio(paths, output) {
  const list = join(workDir, `${output.split("/").at(-1)}.txt`);
  writeFileSync(list, paths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output]);
}

async function navigate(page, path) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1_000);
    }
  }
  throw lastError;
}

async function requireSubmissionState(page) {
  const currentResponse = await page.request.get(`${baseUrl}/api/live/current`);
  if (!currentResponse.ok()) {
    throw new Error(`Live current endpoint returned HTTP ${currentResponse.status()}.`);
  }
  const current = await currentResponse.json();
  if (
    current.mode !== "LIVE_READ_ONLY" ||
    current.status !== "COMPLETE" ||
    current.envelope?.status !== "AVAILABLE" ||
    current.broadcastPermitted !== false ||
    current.transactionSubmitted !== false
  ) {
    throw new Error(`Production live state is not submission-ready: ${JSON.stringify({
      mode: current.mode,
      status: current.status,
      envelopeStatus: current.envelope?.status,
      broadcastPermitted: current.broadcastPermitted,
      transactionSubmitted: current.transactionSubmitted,
    })}`);
  }

  const healthResponses = await Promise.all([
    page.request.get(`${baseUrl}/api/health`),
    page.request.get(`${baseUrl}/api/operations/health`),
  ]);
  for (const response of healthResponses) {
    if (!response.ok()) {
      throw new Error(`Health endpoint returned HTTP ${response.status()}.`);
    }
  }
  const [health, operationsHealth] = await Promise.all(healthResponses.map((response) => response.json()));
  const requiredHealthy = ["archive", "database", "rpc", "oracle", "source"];
  const unhealthy = requiredHealthy.filter((key) => health[key]?.state !== "HEALTHY");
  const operationsUnhealthy = requiredHealthy.filter((key) => operationsHealth[key]?.state !== "HEALTHY");
  if (
    unhealthy.length > 0 ||
    operationsUnhealthy.length > 0 ||
    health.poller?.state !== "HEALTHY" ||
    operationsHealth.poller?.state !== "HEALTHY" ||
    health.broadcastPermitted !== false ||
    operationsHealth.broadcastPermitted !== false ||
    health.transactionSubmitted !== false ||
    operationsHealth.transactionSubmitted !== false ||
    health.executionStaging?.submissionPermitted !== false ||
    operationsHealth.executionStaging?.submissionPermitted !== false
  ) {
    throw new Error(`Production health is not safe to record: ${JSON.stringify({
      unhealthy,
      operationsUnhealthy,
      poller: health.poller?.state,
      operationsPoller: operationsHealth.poller?.state,
      broadcastPermitted: health.broadcastPermitted,
      operationsBroadcastPermitted: operationsHealth.broadcastPermitted,
      transactionSubmitted: health.transactionSubmitted,
      operationsTransactionSubmitted: operationsHealth.transactionSubmitted,
      submissionPermitted: health.executionStaging?.submissionPermitted,
      operationsSubmissionPermitted: operationsHealth.executionStaging?.submissionPermitted,
    })}`);
  }
}

async function preparePage(page, kind) {
  if (kind === "landing") {
    await navigate(page, "/");
    await page.getByRole("heading", { name: "Your position. Protected before liquidation." }).waitFor({ state: "visible", timeout: 20_000 });
    return;
  }

  if (kind === "operations") {
    await navigate(page, "/operations");
    await page.getByRole("heading", { name: "Operations" }).waitFor({ state: "visible", timeout: 20_000 });
    const renderedText = await page.locator("body").innerText();
    if (/Invalid URL/i.test(renderedText)) {
      throw new Error("The rendered operations page contains Invalid URL.");
    }
    for (const requiredText of ["LIVE READ-ONLY", "LIVE MAINNET EXECUTION: DISABLED", "HEALTHY"]) {
      if (!renderedText.includes(requiredText)) {
        throw new Error(`The rendered operations page is missing: ${requiredText}`);
      }
    }
    return;
  }

  await navigate(page, "/overview");
  await page.getByRole("heading", { name: "Position protection" }).waitFor({ state: "visible", timeout: 20_000 });

  if (kind === "overview-evidence" || kind === "overview-preview") {
    const disclosure = page.locator("details.verified-evidence-disclosure");
    if (await disclosure.count()) {
      await disclosure.scrollIntoViewIfNeeded();
      const summary = disclosure.locator("summary");
      if (!(await disclosure.getAttribute("open"))) await summary.click();
    } else {
      const unavailable = page.locator(".live-unavailable-grid");
      await unavailable.scrollIntoViewIfNeeded();
    }
    await page.waitForTimeout(700);
    return;
  }

  if (kind === "phase11") {
    await page.locator("#phase11-evidence").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  }
}

async function recordBrowserScene(browser, scene, duration, output) {
  const sceneDir = join(workDir, `${scene.id}-recording`);
  mkdirSync(sceneDir, { recursive: true });
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "no-preference",
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: sceneDir, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await preparePage(page, scene.kind);
  await page.waitForTimeout(1_000);
  if (scene.kind === "landing" && duration > 18) {
    await page.waitForTimeout(Math.min(2_500, duration * 250));
    await page.locator("#how-it-works").scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(Math.ceil(duration * 1_000) + 2_000);
  const video = page.video();
  await context.close();
  const raw = await video.path();
  if (browserErrors.length > 0) {
    console.warn(`Browser errors in ${scene.id}:`, browserErrors);
  }
  run("ffmpeg", [
    "-y", "-i", raw, "-t", String(duration),
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x050c10,format=yuv420p",
    "-r", "30", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", output,
  ]);
}

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(root, "submission"), { recursive: true });

  const audioSegments = [];
  const subtitleEntries = [];
  let globalTime = 0;
  const sceneMeta = [];

  for (const scene of scenes) {
    const blockAudio = [];
    const blockDurations = [];
    for (let index = 0; index < scene.blocks.length; index += 1) {
      const audioPath = join(workDir, `${scene.id}-${index}.mp3`);
      run(edgeTts, ["--voice", voice, "--rate", "+0%", "--text", scene.blocks[index], "--write-media", audioPath]);
      blockAudio.push(audioPath);
      blockDurations.push(probe(audioPath));
    }
    const sceneAudio = join(workDir, `${scene.id}.mp3`);
    concatAudio(blockAudio, sceneAudio);
    const sceneDuration = probe(sceneAudio);
    let blockTime = globalTime;
    for (let index = 0; index < scene.blocks.length; index += 1) {
      const duration = blockDurations[index];
      subtitleEntries.push({
        start: blockTime,
        end: blockTime + duration,
        text: scene.blocks[index],
      });
      blockTime += duration;
    }
    audioSegments.push(sceneAudio);
    sceneMeta.push({ scene, duration: sceneDuration });
    globalTime += sceneDuration;
  }

  const srt = subtitleEntries.map((entry, index) => `${index + 1}\n${stamp(entry.start)} --> ${stamp(entry.end)}\n${entry.text}\n`).join("\n");
  writeFileSync(outputSrt, srt);

  const browser = await chromium.launch({
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    headless: true,
  });
  const preflightContext = await browser.newContext();
  const preflightPage = await preflightContext.newPage();
  await requireSubmissionState(preflightPage);
  await preflightContext.close();
  const videoSegments = [];
  for (const { scene, duration } of sceneMeta) {
    const output = join(workDir, `${scene.id}.mp4`);
    if (scene.kind === "title" || scene.kind === "closing") {
      makeTitleCard(scene, duration, output);
    } else {
      await recordBrowserScene(browser, scene, duration, output);
    }
    videoSegments.push(output);
  }
  await browser.close();

  const videoList = join(workDir, "video-list.txt");
  writeFileSync(videoList, videoSegments.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  const concatVideo = join(workDir, "concat-video.mp4");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", videoList, "-c", "copy", concatVideo]);
  const concatAudioPath = join(workDir, "concat-audio.mp3");
  concatAudio(audioSegments, concatAudioPath);

  run("ffmpeg", [
    "-y", "-i", concatVideo, "-i", concatAudioPath,
    "-vf", `subtitles=${outputSrt}:force_style='FontName=DejaVu Sans,FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H00050C10,BorderStyle=1,Outline=2,Shadow=0,MarginV=44,Alignment=2'`,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-shortest", "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", outputVideo,
  ]);

  console.log(`Demo video: ${outputVideo}`);
  console.log(`Subtitles: ${outputSrt}`);
  console.log(`Duration: ${probe(outputVideo).toFixed(2)} seconds`);
  console.log(`Resolution: ${execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", outputVideo], { encoding: "utf8" }).trim()}`);
}

await main();
