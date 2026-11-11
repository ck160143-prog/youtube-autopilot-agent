const test = require("node:test");
const assert = require("node:assert/strict");
const { app, isQuotaError, getStatus, resetAIClientFactory, setAIClientFactoryForTests } = require("../server");

async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("health endpoint reports server status without exposing secrets", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/health");
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(Object.hasOwn(data, "apiKey"), false);
  });
});

test("script and SEO reject missing topics before calling Gemini", async () => {
  await withServer(async base => {
    for (const endpoint of ["/api/script", "/api/seo"]) {
      const response = await fetch(base + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(response.status, 400, endpoint);
      assert.ok((await response.json()).error);
    }
  });
});

test("voice rejects empty text before calling Gemini", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " })
    });
    assert.equal(response.status, 400);
  });
});

test("unknown API paths return JSON 404", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/not-a-real-route");
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
  });
});

test("quota classification avoids treating generic billing wording as quota exhaustion", () => {
  assert.equal(isQuotaError({ status: 429, message: "RESOURCE_EXHAUSTED" }), true);
  assert.equal(isQuotaError({ status: 403, message: "Billing account disabled" }), false);
  assert.equal(getStatus({ status: 503 }), 503);
});

test("script generation returns a setup error when the API key is missing", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  resetAIClientFactory();
  try {
    await withServer(async base => {
      const response = await fetch(base + "/api/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "हिंदी प्रेरणा", duration: 5, language: "हिंदी" })
      });
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /API key configure/);
    });
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    resetAIClientFactory();
  }
});

test("AI thumbnail endpoint rejects missing topic before provider invocation", async () => {
  await withServer(async base => {
    const response=await fetch(base+"/api/thumbnail/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});
    assert.equal(response.status,400);assert.match((await response.json()).error,/topic|विषय/i);
  });
});

test("AI thumbnail endpoint returns provider image bytes without exposing provider secrets", async () => {
  const previousKey=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY="test-thumbnail-key";
  setAIClientFactoryForTests(()=>({models:{async generateContent(args){
    assert.ok(args.config.responseModalities.includes("IMAGE"));
    return {candidates:[{content:{parts:[{inlineData:{mimeType:"image/png",data:Buffer.from("image-fixture").toString("base64")}}]}}]};
  }}}));
  try{await withServer(async base=>{
    const response=await fetch(base+"/api/thumbnail/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({topic:"Taj Mahal",title:"22 बंद कमरे",visualStyle:"cinematic"})});
    const data=await response.json();assert.equal(response.status,200);assert.equal(data.success,true);assert.equal(data.mimeType,"image/png");
    assert.equal(Buffer.from(data.imageBase64,"base64").toString(),"image-fixture");
  });}finally{resetAIClientFactory();if(previousKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previousKey;}
});
