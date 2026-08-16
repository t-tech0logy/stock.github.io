window.PLAINSTOCK_ASSISTANT_CONFIG = {
  // Testing configuration. These browser-visible keys must remain disposable
  // and protected with strict provider quotas.
  geminiApiKey: "AQ.Ab8RN6JCfXODdIhLko0Q5TWH-zsHREsnMz8Xoa6aqgFPcKeHNg",
  geminiApiKeys: [
    "AQ.Ab8RN6LqLCcPdSw24lib8P6-9x9z299gkAO-a8_VBDr2QD7CYw",
    "AQ.Ab8RN6K3DqICar0VWfCD_vevBZXpva6V69vBMqISSOzKXy3ATw"
  ],
  geminiApiRoot: "https://generativelanguage.googleapis.com/v1beta",
  modelRoutes: {
    normal: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    stock: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    futures: ["gemini-2.5-flash-lite", "gemini-2.5-flash"]
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
    specialist: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    synthesis: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    validator: ["gemini-2.5-flash-lite", "gemini-2.5-flash"]
  },
  keyCooldownMs: 60000,
  responseCacheTtlMs: 900000
};
