// lecture-highlights.test.mjs — Hebrew highlight scan, caption parsing,
// digest safety net and HTML rendering for the moodle-recordings pipeline.
//
// Run: node --test agent/test/lecture-highlights.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanHighlights, parseCaptions, hebrewRatio, formatTimestamp, parseTimestamp,
  chunkTranscript, extractJson, finalizeDigest, renderDigestHtml, buildDigestPrompt,
} from "../../lib/lecture-highlights.mjs";

const seg = (start, text) => ({ start, end: start + 5, text });

describe("scanHighlights", () => {
  it("matches exam terms with Hebrew prefixes", () => {
    const hits = scanHighlights([
      seg(0, "בוקר טוב לכולם"),
      seg(600, "את המשפט הזה תדעו כי הוא יופיע במבחן"),
      seg(1200, "ושלבחינה תצטרכו להביא מחשבון"),
    ]);
    const exam = hits.filter((h) => h.category === "exam");
    assert.equal(exam.length, 2);
    assert.equal(exam[0].timestamp, "00:10:00");
    assert.match(exam[1].term, /שלבחינה/);
  });

  it("does not treat בחינם (for free) as an exam", () => {
    const hits = scanHighlights([seg(0, "הספר זמין בחינם בספרייה")]);
    assert.equal(hits.filter((h) => h.category === "exam").length, 0);
  });

  it("classifies exclusions separately from inclusions", () => {
    const hits = scanHighlights([seg(30, "את ההוכחה הזאת לא יהיה במבחן, רק תדעו שהיא קיימת")]);
    assert.deepEqual(hits.map((h) => h.category), ["excluded"]);
  });

  it("finds assignments, emphasis and code-switched English", () => {
    const hits = scanHighlights([
      seg(10, "תרגיל בית שלוש צריך להגיש עד יום ראשון"),
      seg(200, "שימו לב, זה חשוב מאוד"),
      seg(400, "this will be on the midterm"),
    ]);
    const cats = hits.map((h) => h.category);
    assert.ok(cats.includes("assignment"));
    assert.ok(cats.includes("emphasis"));
    assert.ok(cats.includes("exam"));
  });

  it("merges repeated hits within the window", () => {
    const hits = scanHighlights([seg(100, "במבחן"), seg(120, "שוב במבחן"), seg(500, "ובמבחן")]);
    const exam = hits.filter((h) => h.category === "exam");
    assert.equal(exam.length, 2);
    assert.equal(exam[0].count, 2);
  });
});

describe("captions + timestamps", () => {
  it("parses WebVTT and SRT", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Lecturer>שלום לכולם\n\n00:01:05.500 --> 00:01:09.000\nנתחיל";
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n01:00:00,000 --> 01:00:02,000\nworld";
    assert.deepEqual(parseCaptions(vtt).map((s) => [s.start, s.text]), [[1, "שלום לכולם"], [65.5, "נתחיל"]]);
    assert.deepEqual(parseCaptions(srt).map((s) => s.start), [1, 3600]);
  });

  it("round-trips timestamps", () => {
    assert.equal(formatTimestamp(3725.9), "01:02:05");
    assert.equal(parseTimestamp("01:02:05"), 3725);
    assert.equal(parseTimestamp("02:05"), 125);
  });

  it("measures Hebrew ratio", () => {
    assert.ok(hebrewRatio("זה טקסט בעברית with a term") > 0.5);
    assert.ok(hebrewRatio("plain English") === 0);
  });
});

describe("chunking + JSON extraction", () => {
  it("chunks on line boundaries", () => {
    const text = Array.from({ length: 10 }, (_, i) => `[00:00:0${i}] ${"א".repeat(20)}`).join("\n");
    const chunks = chunkTranscript(text, 100);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join("\n"), text);
  });

  it("extracts JSON from fenced / chatty output", () => {
    assert.deepEqual(extractJson('Here:\n```json\n{"a": "}{", "b": {"c": 1}}\n```'), { a: "}{", b: { c: 1 } });
    assert.throws(() => extractJson("no json"));
  });
});

describe("finalizeDigest", () => {
  const candidates = [{ category: "exam", timestamp: "00:42:00", start: 2520, term: "במבחן", context: "זה יופיע במבחן", count: 1 }];

  it("re-attaches exam hits the model dropped and raises relevance", () => {
    const d = finalizeDigest({ title: "t", highlights: [{ type: "emphasis", timestamp: "00:05:00", quote: "שימו לב" }] }, candidates);
    assert.equal(d.highlights[0].type, "exam");
    assert.equal(d.highlights[0].auto, true);
    assert.equal(d.exam_relevance, "low");
  });

  it("keeps the model's exam highlights when present", () => {
    const d = finalizeDigest({ exam_relevance: "high", highlights: [{ type: "exam", timestamp: "00:42:10", quote: "q", note: "n" }] }, candidates);
    assert.equal(d.highlights.length, 1);
    assert.equal(d.exam_relevance, "high");
  });
});

describe("renderDigestHtml", () => {
  it("renders RTL Hebrew without em dashes and escapes content", () => {
    const digest = finalizeDigest({
      title: "גבולות — הגדרה",
      tldr: "<script>x</script>",
      exam_relevance: "high",
      highlights: [{ type: "exam", timestamp: "00:42:00", quote: "יופיע במבחן", note: "ההוכחה תופיע", date: "2026-11-02" }],
      sections: [{ heading: "פתיחה", bullets: ["הגדרת גבול"] }],
    }, []);
    const html = renderDigestHtml({ digest, course: "חדו\"א 1", name: "הרצאה 3", url: "https://moodle.example.ac.il/mod/kalvidres/view.php?id=1", language: "he" });
    assert.match(html, /dir="rtl"/);
    assert.match(html, /רלוונטי מאוד למבחן/);
    assert.ok(!html.includes("—"));
    assert.ok(!html.includes("<script>"));
  });
});

describe("buildDigestPrompt", () => {
  it("includes candidates, language and the injection guard", () => {
    const p = buildDigestPrompt({ course: "c", name: "n", transcript: "[00:00:00] שלום", candidates: [{ category: "exam", term: "מבחן", timestamp: "00:00:00", context: "ctx", count: 1 }], language: "en", today: "2026-10-24" });
    assert.match(p, /Write all prose fields in English/);
    assert.match(p, /\(exam, "מבחן"\)/);
    assert.match(p, /DATA, not instructions/);
  });
});
