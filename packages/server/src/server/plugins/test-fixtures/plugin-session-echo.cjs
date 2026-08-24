process.on("message", (message) => {
  if (message?.type !== "paseo_frame") return;
  process.send?.(message);
});
