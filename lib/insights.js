"use strict";

// Analytics -> content advice.
//
// The hard rule: never invent a number. Everything here is derived from rows the
// YouTube Analytics API actually returned. When there is not enough data to say
// anything useful, the honest answer is "not enough data yet" — not a made-up
// recommendation.
//
// Deliberately NOT computed:
//   - CTR (impressions click-through): YouTube Analytics does not expose
//     impressions for channel-owner reports. It is only available from YouTube
//     Studio. Claiming a CTR would be fabricating a metric.
//   - Retention curve: requires audienceRetention reports, which are a separate
//     report type. Only averageViewDuration is used here.

const MIN_VIEWS_FOR_ADVICE = 50;
const MIN_DAYS_FOR_TREND = 7;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Groups day rows into weeks (newest last) so a trend is not one noisy day.
function weeklyBuckets(entries) {
  const sorted = (entries || [])
    .filter(e => e && e.day)
    .map(e => ({ day: String(e.day), views: number(e.views), minutes: number(e.estimatedMinutesWatched) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const weeks = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const slice = sorted.slice(i, i + 7);
    weeks.push({
      start: slice[0].day,
      end: slice[slice.length - 1].day,
      days: slice.length,
      views: slice.reduce((sum, d) => sum + d.views, 0),
      minutes: slice.reduce((sum, d) => sum + d.minutes, 0),
    });
  }
  return weeks;
}

function buildInsights(report) {
  const entries = Array.isArray(report && report.entries) ? report.entries : [];
  const totals = (report && report.totals) || {};
  const views = number(totals.views);
  const minutes = number(totals.estimatedMinutesWatched);
  const avgDuration = number(totals.averageViewDuration);
  const subs = number(totals.subscribersGained);
  const likes = number(totals.likes);
  const days = entries.length;

  const observations = [];
  const suggestions = [];
  const notAvailable = [
    { metric: "CTR (impressions click-through)", why: "YouTube Analytics में channel-owner reports के लिए impressions उपलब्ध नहीं; यह सिर्फ YouTube Studio में दिखता है।" },
    { metric: "Retention curve", why: "audienceRetention अलग report type है; यहाँ सिर्फ average view duration है।" },
  ];

  // Not enough data is a finding in itself: say it instead of guessing.
  if (days === 0) {
    return {
      enoughData: false,
      days: 0,
      totals: { views, minutes, avgDuration, subs, likes },
      observations: [],
      suggestions: [],
      notAvailable,
      verdict: "इस अवधि में कोई डेटा नहीं मिला — सुझाव देने के लिए पर्याप्त जानकारी नहीं है। कोई अनुमान नहीं लगाया गया।",
    };
  }

  observations.push(days + " दिन का डेटा, कुल " + views + " व्यूज़, " + Math.round(minutes) + " मिनट watch time।");

  const weeks = weeklyBuckets(entries);
  if (weeks.length >= 2) {
    const last = weeks[weeks.length - 1];
    const prev = weeks[weeks.length - 2];
    if (prev.views > 0) {
      const pct = Math.round(((last.views - prev.views) / prev.views) * 100);
      observations.push("पिछले हफ़्ते के मुकाबले व्यूज़ " + (pct >= 0 ? "+" : "") + pct + "% (" +
        prev.views + " → " + last.views + ")।");
      if (pct <= -20) {
        suggestions.push("व्यूज़ लगातार गिर रहे हैं: अगले वीडियो का शीर्षक/thumbnail पिछले अच्छे प्रदर्शन वाले विषय जैसा रखें, और उस विषय को दोहराएँ जिसने पहले व्यूज़ दिए।");
      } else if (pct >= 20) {
        suggestions.push("व्यूज़ बढ़ रहे हैं: इसी विषय की अगली कड़ी (series) बनाएँ — बढ़ती रुचि का फ़ायदा उठाएँ।");
      }
    }
  } else {
    observations.push("ट्रेंड बताने के लिए कम से कम 2 हफ़्ते चाहिए (" + MIN_DAYS_FOR_TREND + "+ दिन); अभी " + days + " दिन हैं।");
  }

  if (views >= MIN_VIEWS_FOR_ADVICE && avgDuration > 0) {
    observations.push("औसत व्यू अवधि " + Math.round(avgDuration) + " सेकंड है।");
    if (avgDuration < 90) {
      suggestions.push("औसत व्यू अवधि " + Math.round(avgDuration) + " सेकंड है (90 सेकंड से कम): पहले 15 सेकंड में मुख्य सवाल उठाएँ और दृश्य बदलाव तेज़ रखें; 30 मिनट की जगह छोटा, कसा हुआ वीडियो बनाएँ।");
    } else if (avgDuration >= 240) {
      suggestions.push("औसत व्यू अवधि " + Math.round(avgDuration) + " सेकंड अच्छी है: लंबे (5–10 मिनट) वीडियो बनाने का मौका है, दर्शक टिक रहे हैं।");
    }
    if (views > 0) {
      const subsPerK = (subs / views) * 1000;
      observations.push("हर 1000 व्यूज़ पर " + subsPerK.toFixed(1) + " नए subscriber।");
      if (subsPerK < 2) {
        suggestions.push("हर 1000 व्यूज़ पर subscribers कम हैं: वीडियो के अंत में एक साफ़ call-to-action जोड़ें और series बनाकर लौटने की वजह दें।");
      }
    }
    if (views > 0) {
      const likeRate = (likes / views) * 100;
      observations.push("लाइक दर " + likeRate.toFixed(1) + "%।");
      if (likeRate < 1.5) {
        suggestions.push("लाइक दर कम है (" + likeRate.toFixed(1) + "%): पसंद आने पर लाइक के लिए एक छोटा, विनम्र अनुरोध जोड़ें।");
      }
    }
  } else if (views < MIN_VIEWS_FOR_ADVICE) {
    observations.push("सुझाव देने के लिए पर्याप्त व्यूज़ नहीं (" + views + "/" + MIN_VIEWS_FOR_ADVICE + ")।");
  }

  return {
    enoughData: views >= MIN_VIEWS_FOR_ADVICE,
    days,
    totals: { views, minutes, avgDuration, subs, likes },
    weeks,
    observations,
    suggestions,
    notAvailable,
    verdict: views >= MIN_VIEWS_FOR_ADVICE
      ? "डेटा पर्याप्त है; नीचे दिए सुझाव सिर्फ इसी अवधि के असली आंकड़ों से बने हैं।"
      : "डेटा कम है — जो दिख रहा है वही बताया गया है, कोई अनुमान नहीं जोड़ा गया।",
  };
}

module.exports = { buildInsights, weeklyBuckets, MIN_VIEWS_FOR_ADVICE, MIN_DAYS_FOR_TREND };
