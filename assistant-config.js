const PLAINSTOCK_MODELS_STRONG_FIRST = Object.freeze([
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro"
]);

const PLAINSTOCK_MODELS_LIGHT_FIRST = Object.freeze([
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro"
]);

window.PLAINSTOCK_ASSISTANT_CONFIG = {
  // Testing configuration. These browser-visible keys must remain disposable
  // and protected with strict provider quotas.
  geminiApiKey: "AQ.Ab8RN6L1kHIt5EyiFtlIPQeprKLC80hSPfC81D4zFjPNlv7Ocw",
  geminiApiKeys: [
    "AQ.Ab8RN6LkFP_GjE6wFnpvvSlRA8WG-n6mLvdO6CDZLnnTqCljBA",
    "AQ.Ab8RN6Lz0YPdgIS0OaQbFGECt5RIsSDStajt3Gybk0wcxqYEZA"
  ],
  geminiApiRoot: "https://generativelanguage.googleapis.com/v1beta",
  modelRoutes: {
    normal: PLAINSTOCK_MODELS_LIGHT_FIRST,
    stock: PLAINSTOCK_MODELS_STRONG_FIRST,
    futures: PLAINSTOCK_MODELS_STRONG_FIRST
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
    specialist: PLAINSTOCK_MODELS_LIGHT_FIRST,
    synthesis: PLAINSTOCK_MODELS_STRONG_FIRST,
    validator: PLAINSTOCK_MODELS_STRONG_FIRST
  },
  keyCooldownMs: 60000,
  responseCacheTtlMs: 900000
};
