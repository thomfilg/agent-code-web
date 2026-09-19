import http from "node:http";
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid fixture counter port");
const request = http.request({ hostname: "127.0.0.1", port, path: "/tool-counter", method: "POST", timeout: 10000 }, response => {
  if (response.statusCode !== 200) { response.resume(); process.exitCode = 1; return; }
  response.pipe(process.stdout);
});
request.on("timeout", () => request.destroy(Error("Fixture counter timed out")));
request.on("error", () => { process.exitCode = 1; });
request.end("{}");
