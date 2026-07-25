// Nothing to expose yet — no renderer code currently needs main-process-
// mediated data. When later ingest work needs it (non-negotiable #6: API
// keys stay in main, proxied through here, never a raw ipcRenderer
// passthrough), that bridge goes here.
export {};
