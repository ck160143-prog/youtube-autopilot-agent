"use strict";
const express = require("express");

function createGrowthRouter({ getOwner, getStore, getAccessToken, aiClientFactory, fetchImpl = globalThis.fetch }) {
  const router = express.Router();
  const api = async (url, token) => {
    const response = await fetchImpl(url, { headers: { Authorization: "Bearer " + token } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error?.message || ("Google API request failed (HTTP " + response.status + ")"));
      error.status = response.status;
      throw error;
    }
    return body;
  };
  const ownerFor = (req, res) => {
    const owner = getOwner(req);
    if (!owner) { res.status(401).json({ error: "पहले YouTube चैनल Connect करें।" }); return null; }
    return owner;
  };
  const storeFor = async () => {
    const store = await getStore();
    if (!store?.pool) throw new Error("DATABASE_URL is required for the growth dashboard.");
    return store;
  };

  router.get("/overview", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    try {
      const token = await getAccessToken(req, res); if (!token) return;
      const channelData = await api("https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&mine=true", token);
      const channel = channelData.items?.[0];
      if (!channel?.id || channel.id !== owner) return res.status(403).json({ error: "OAuth channel and stored job owner do not match. Reconnect the intended channel." });
      const stats = channel.statistics || {};
      const subscribers = stats.hiddenSubscriberCount ? null : (Number.isFinite(Number(stats.subscriberCount)) ? Number(stats.subscriberCount) : null);
      let analytics = null, analyticsAccessRequired = false;
      const end = new Date(), start = new Date(end.getTime() - 27 * 86400000);
      const date = d => d.toISOString().slice(0,10);
      try {
        analytics = await api("https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=" + date(start) + "&endDate=" + date(end) + "&metrics=views%2CestimatedMinutesWatched%2CsubscribersGained&dimensions=day&sort=day", token);
      } catch (error) {
        if (error.status === 403 || error.status === 401) analyticsAccessRequired = true;
        else throw error;
      }
      const rows = analytics?.rows || [];
      const total = rows.reduce((acc, row) => ({ views: acc.views + Number(row[1] || 0), minutes: acc.minutes + Number(row[2] || 0), gained: acc.gained + Number(row[3] || 0) }), { views: 0, minutes: 0, gained: 0 });
      const db = await storeFor();
      await db.pool.query(
        "INSERT INTO baba_channel_metrics(channel_id,snapshot_date,subscribers,total_views,video_count,estimated_minutes_watched,subscribers_gained,source,captured_at) VALUES($1,CURRENT_DATE,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(channel_id,snapshot_date) DO UPDATE SET subscribers=EXCLUDED.subscribers,total_views=EXCLUDED.total_views,video_count=EXCLUDED.video_count,estimated_minutes_watched=COALESCE(EXCLUDED.estimated_minutes_watched,baba_channel_metrics.estimated_minutes_watched),subscribers_gained=COALESCE(EXCLUDED.subscribers_gained,baba_channel_metrics.subscribers_gained),source=EXCLUDED.source,captured_at=NOW()",
        [owner, subscribers, Number(stats.viewCount || 0), Number(stats.videoCount || 0), analytics ? total.minutes : null, analytics ? total.gained : null, analytics ? "youtube_data_and_analytics_api" : "youtube_data_api"]
      );
      const history = await db.pool.query("SELECT snapshot_date,subscribers,total_views,video_count,estimated_minutes_watched,subscribers_gained FROM baba_channel_metrics WHERE channel_id=$1 ORDER BY snapshot_date DESC LIMIT 30", [owner]);
      return res.json({
        channel: { id: channel.id, title: channel.snippet?.title || "", subscribers, totalViews: Number(stats.viewCount || 0), videoCount: Number(stats.videoCount || 0) },
        last28Days: analytics ? total : null,
        analyticsAccessRequired,
        history: history.rows,
        subscriberGoal: { current: subscribers, target: 1000, progressPercent: subscribers === null ? null : Math.min(100, Math.round(subscribers / 10)) },
        notice: analyticsAccessRequired ? "Watch-time analytics के लिए अगली बार Connect करते समय YouTube Analytics read permission दें। मौजूदा channel connection हटाया नहीं गया है।" : "Analytics Google के authenticated channel से प्राप्त हुए हैं।"
      });
    } catch (error) {
      if (error.message?.includes("DATABASE_URL")) return res.status(503).json({ error: error.message });
      return res.status(error.status === 403 ? 403 : 502).json({ error: "Growth data नहीं मिल सका। YouTube API permission/quota और database migration जाँचें।" });
    }
  });

  router.get("/trending", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    const query = String(req.query.q || "").trim();
    if (query.length < 2 || query.length > 100) return res.status(400).json({ error: "Trend खोजने के लिए 2–100 अक्षरों का विषय दें।" });
    try {
      const token = await getAccessToken(req, res); if (!token) return;
      const publishedAfter = new Date(Date.now() - 7 * 86400000).toISOString();
      const search = await api("https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10&publishedAfter=" + encodeURIComponent(publishedAfter) + "&q=" + encodeURIComponent(query), token);
      const ids = (search.items || []).map(x => x.id?.videoId).filter(Boolean);
      if (!ids.length) return res.json({ query, windowDays: 7, videos: [], disclaimer: "यह recent YouTube search signal है, कमाई की गारंटी नहीं।" });
      const details = await api("https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=" + encodeURIComponent(ids.join(",")), token);
      const videos = (details.items || []).map(v => ({
        id: v.id, title: v.snippet?.title || "", channelTitle: v.snippet?.channelTitle || "",
        publishedAt: v.snippet?.publishedAt || null, views: Number(v.statistics?.viewCount || 0),
        url: "https://www.youtube.com/watch?v=" + v.id
      })).sort((a,b) => b.views-a.views);
      return res.json({ query, windowDays: 7, videos, disclaimer: "Ranking हाल के 7 दिनों के public YouTube view counts पर आधारित है; यह भविष्य के views या revenue की भविष्यवाणी नहीं है।" });
    } catch (error) {
      return res.status(error.status === 403 ? 403 : 502).json({ error: "Trend data नहीं मिल सका। YouTube Data API quota/permission जाँचें।" });
    }
  });

  router.get("/promotions", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    try {
      const db = await storeFor();
      const rows = await db.pool.query("SELECT id,name,promotion_type,url,amount,currency,status,notes,created_at,updated_at FROM baba_promotions WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 100", [owner]);
      return res.json({ promotions: rows.rows });
    } catch (_) { return res.status(503).json({ error: "Promotion database उपलब्ध नहीं है। Growth migration लागू करें।" }); }
  });

  router.post("/promotions", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const type = body.promotionType;
    const amount = Number(body.amount ?? 0);
    const currency = String(body.currency || "INR").toUpperCase();
    const url = body.url ? String(body.url).trim() : null;
    if (!name || name.length > 160) return res.status(400).json({ error: "Promotion name required (max 160 characters)." });
    if (!["sponsorship","affiliate"].includes(type)) return res.status(400).json({ error: "promotionType must be sponsorship or affiliate." });
    if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: "Enter a valid non-negative amount and 3-letter currency." });
    if (url && (!/^https:\/\//i.test(url) || url.length > 2000)) return res.status(400).json({ error: "Promotion URL must be HTTPS and at most 2000 characters." });
    try {
      const db = await storeFor();
      const result = await db.pool.query("INSERT INTO baba_promotions(channel_id,name,promotion_type,url,amount,currency,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,promotion_type,url,amount,currency,status,notes,created_at", [owner,name,type,url,amount,currency,body.status === "active" ? "active" : "planned",String(body.notes || "").slice(0,2000)]);
      return res.status(201).json({ promotion: result.rows[0] });
    } catch (_) { return res.status(503).json({ error: "Promotion save नहीं हुई। Growth migration लागू करें और database जाँचें।" }); }
  });

  router.patch("/promotions/:id", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid promotion id." });
    const { status, amount, notes } = req.body || {};
    if (status !== undefined && !["planned","active","completed","cancelled"].includes(status)) return res.status(400).json({ error: "Invalid promotion status." });
    if (amount !== undefined && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) return res.status(400).json({ error: "amount must be non-negative." });
    try {
      const db = await storeFor();
      const result = await db.pool.query("UPDATE baba_promotions SET status=COALESCE($3,status),amount=COALESCE($4,amount),notes=COALESCE($5,notes),updated_at=NOW() WHERE channel_id=$1 AND id=$2 RETURNING id,name,promotion_type,url,amount,currency,status,notes,updated_at", [owner,req.params.id,status ?? null,amount === undefined ? null : Number(amount),notes === undefined ? null : String(notes).slice(0,2000)]);
      return result.rows[0] ? res.json({ promotion: result.rows[0] }) : res.status(404).json({ error: "Promotion not found." });
    } catch (_) { return res.status(503).json({ error: "Promotion update नहीं हुई। Database जाँचें।" }); }
  });

  router.get("/monetization", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    try {
      const db = await storeFor();
      const result = await db.pool.query("SELECT public_watch_hours,shorts_views_90d,notes,updated_at FROM baba_monetization_inputs WHERE channel_id=$1", [owner]);
      return res.json({ inputs: result.rows[0] || null, basis: "Watch hours and Shorts views are user-entered values; this dashboard does not certify YouTube Partner Program eligibility." });
    } catch (_) { return res.status(503).json({ error: "Monetization tracker के लिए growth migration लागू करें।" }); }
  });

  router.put("/monetization", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    const hours = req.body?.publicWatchHours === null ? null : Number(req.body?.publicWatchHours);
    const shorts = req.body?.shortsViews90d === null ? null : Number(req.body?.shortsViews90d);
    if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 10000000)) return res.status(400).json({ error: "publicWatchHours must be between 0 and 10,000,000." });
    if (shorts !== null && (!Number.isSafeInteger(shorts) || shorts < 0)) return res.status(400).json({ error: "shortsViews90d must be a non-negative integer." });
    try {
      const db = await storeFor();
      const result = await db.pool.query("INSERT INTO baba_monetization_inputs(channel_id,public_watch_hours,shorts_views_90d,notes,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(channel_id) DO UPDATE SET public_watch_hours=EXCLUDED.public_watch_hours,shorts_views_90d=EXCLUDED.shorts_views_90d,notes=EXCLUDED.notes,updated_at=NOW() RETURNING *", [owner,hours,shorts,String(req.body?.notes || "").slice(0,2000)]);
      return res.json({ inputs: result.rows[0], basis: "User-entered metrics; not an official eligibility determination." });
    } catch (_) { return res.status(503).json({ error: "Monetization data save नहीं हुआ। Growth migration लागू करें।" }); }
  });

  router.post("/niches", async (req, res) => {
    const owner = ownerFor(req, res); if (!owner) return;
    const topic = String(req.body?.interest || "").trim().slice(0,200);
    if (!topic) return res.status(400).json({ error: "अपना interest या niche category लिखें।" });
    if (!process.env.GEMINI_API_KEY || typeof aiClientFactory !== "function") return res.status(503).json({ error: "Niche research के लिए Gemini server configuration उपलब्ध नहीं है।" });
    try {
      const prompt = "हिंदी faceless YouTube channel के लिए 5 niche ideas का JSON लौटाएँ। Input interest: " + topic + ". प्रत्येक में niche, audience, contentAngles (3), competition (low/medium/high), monetizationPaths (3), productionDifficulty (low/medium/high), estimatedPotentialScore (1-100) दें। Score केवल qualitative AI estimate है; वास्तविक RPM, revenue या trend guarantee न बताएं। JSON object shape {niches:[...]}.";
      const generated = await aiClientFactory().models.generateContent({ model: process.env.GEMINI_SCRIPT_MODEL || "gemini-3.8-flash", contents: prompt, config: { responseMimeType: "application/json" } });
      const parsed = JSON.parse(String(generated.text || "").replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));
      if (!Array.isArray(parsed.niches) || !parsed.niches.length) throw new Error("No valid niche results");
      return res.json({ interest: topic, niches: parsed.niches.slice(0,5), disclaimer: "AI-based qualitative estimates only. Validate demand, competition and revenue independently before investing." });
    } catch (_) { return res.status(502).json({ error: "Niche research generation failed. Check Gemini quota/model configuration." }); }
  });

  return router;
}
module.exports = { createGrowthRouter };
