window.PLAINSTOCK_ASSISTANT_CONFIG = {
  // Temporary static-project setup: browser keys are visible to every visitor.
  // Paste one Gemini key below, or use several keys from separate projects.
  geminiApiKey: "AQ.Ab8RN6JCfXODdIhLko0Q5TWH-zsHREsnMz8Xoa6aqgFPcKeHNg",
  geminiApiKeys: [
    "AQ.Ab8RN6LqLCcPdSw24lib8P6-9x9z299gkAO-a8_VBDr2QD7CYw",
    "AQ.Ab8RN6K3DqICar0VWfCD_vevBZXpva6V69vBMqISSOzKXy3ATw"
  ],
  geminiApiRoot: "https://generativelanguage.googleapis.com/v1beta",

  // Free-tier-friendly models are attempted first. Newer Flash models remain
  // available as fallbacks when your Gemini project has access to them.
  modelRoutes: {
    normal: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
    stock: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
    futures: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash-lite"]
  },

  // Stock and Futures use three specialist skills. Normal mode remains one fast request.
  agentWorkflows: {
    stock: true,
    futures: true
  },
  agentValidation: {
    normal: true,
    stock: true,
    futures: true
  },
  agentRoutes: {
    specialist: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
    synthesis: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
    validator: ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"]
  },
  keyCooldownMs: 60000,
  // Reuse an identical checked answer for 15 minutes in the same browser tab.
  responseCacheTtlMs: 900000,

  // Futures uses the same market-data key as the stock dashboard by default.
  futuresApiRoot: "https://api.massive.com",
  futuresApiKey: ""
};
