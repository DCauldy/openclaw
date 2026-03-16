import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type TranscriptEntry = { start: number; duration: number; text: string };

// Accepts a full YouTube URL (all common forms) or a bare 11-char video ID.
function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    if (url.hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v) return v;
      // youtube.com/shorts/VIDEO_ID and /embed/VIDEO_ID
      const parts = url.pathname.split("/").filter(Boolean);
      if ((parts[0] === "shorts" || parts[0] === "embed") && parts[1]) return parts[1];
    }
  } catch {
    // not a parseable URL
  }
  return null;
}

// Walk balanced braces to extract the full JSON object after a key.
function extractJsonValue(html: string, key: string): unknown | null {
  const idx = html.indexOf(key);
  if (idx === -1) return null;
  const start = html.indexOf("{", idx);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let i = start;
  while (i < html.length) {
    const c = html[i];
    if (inString) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
    } else {
      if (c === '"') {
        inString = true;
      } else if (c === "{" || c === "[") {
        depth++;
      } else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    i++;
  }
  return null;
}

function parseTranscriptXml(xml: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const text = match[3]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/<[^>]+>/g, "") // strip inline tags (e.g. <font>)
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      entries.push({ start: parseFloat(match[1]), duration: parseFloat(match[2]), text });
    }
  }
  return entries;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

async function fetchTranscript(
  videoId: string,
  lang: string,
): Promise<{
  entries: TranscriptEntry[];
  videoTitle: string | null;
  availableLanguages: string[];
}> {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!pageRes.ok) throw new Error(`YouTube page returned HTTP ${pageRes.status}`);
  const html = await pageRes.text();

  const playerResponse = extractJsonValue(html, "ytInitialPlayerResponse") as Record<
    string,
    unknown
  > | null;
  if (!playerResponse) throw new Error("Could not parse YouTube player response");

  const videoDetails = playerResponse.videoDetails as Record<string, unknown> | undefined;
  const videoTitle = (videoDetails?.title as string | undefined) ?? null;

  const tracks = (
    (playerResponse.captions as Record<string, unknown> | undefined)
      ?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined
  )?.captionTracks as Array<Record<string, unknown>> | undefined;

  if (!tracks?.length) {
    throw new Error(
      "No captions available for this video (the video may be private or have captions disabled)",
    );
  }

  const availableLanguages = tracks.map((t) => t.languageCode as string);

  // Pick the best matching track, preferring exact match then prefix, then first available.
  const langBase = lang.split("-")[0];
  const track =
    tracks.find((t) => t.languageCode === lang) ??
    tracks.find((t) => (t.languageCode as string).startsWith(langBase)) ??
    tracks[0];

  const baseUrl = track?.baseUrl as string | undefined;
  if (!baseUrl) throw new Error("Could not find caption track URL");

  const transcriptRes = await fetch(baseUrl, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!transcriptRes.ok) throw new Error(`Caption fetch returned HTTP ${transcriptRes.status}`);
  const xml = await transcriptRes.text();

  const entries = parseTranscriptXml(xml);
  if (!entries.length) throw new Error("Transcript was empty after parsing");

  return { entries, videoTitle, availableLanguages };
}

const YoutubeTranscriptSchema = Type.Object({
  url: Type.String({
    description:
      "YouTube video URL (youtube.com/watch?v=…, youtu.be/…, shorts/…) or bare 11-character video ID.",
  }),
  language: Type.Optional(
    Type.String({
      description:
        "BCP 47 language code for the caption track (e.g. 'en', 'es', 'fr'). Defaults to 'en'; falls back to the first available track.",
    }),
  ),
  format: Type.Optional(
    Type.Unsafe<"text" | "timestamped">({
      type: "string",
      enum: ["text", "timestamped"],
      description:
        "'text' returns clean prose (default). 'timestamped' prefixes each segment with [M:SS].",
    }),
  ),
});

export function createYoutubeTranscriptTool(): AnyAgentTool {
  return {
    label: "YouTube Transcript",
    name: "youtube_transcript",
    description:
      "Fetch the spoken transcript (captions/subtitles) of a YouTube video given its URL or video ID. Use this to summarize, quote, or analyze video content without watching it.",
    parameters: YoutubeTranscriptSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const language = readStringParam(params, "language") ?? "en";
      const format = readStringParam(params, "format") ?? "text";

      const videoId = extractVideoId(url);
      if (!videoId) {
        return jsonResult({ success: false, error: `Cannot extract a video ID from: ${url}` });
      }

      try {
        const { entries, videoTitle, availableLanguages } = await fetchTranscript(
          videoId,
          language,
        );

        const transcript =
          format === "timestamped"
            ? entries.map((e) => `[${formatTimestamp(e.start)}] ${e.text}`).join("\n")
            : entries.map((e) => e.text).join(" ");

        return jsonResult({
          success: true,
          videoId,
          videoTitle,
          language,
          availableLanguages,
          segmentCount: entries.length,
          characterCount: transcript.length,
          transcript,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          videoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
