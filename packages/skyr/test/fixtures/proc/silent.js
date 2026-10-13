// Ignores SIGTERM: exercises the SIGKILL escalation; dies with no result.
process.on("SIGTERM", () => {
  // silence: keep running
});
setInterval(() => {}, 100);
