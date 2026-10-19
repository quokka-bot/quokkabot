// Red team from the CLI sandbox's network position (where only the unmodified Claude Code CLI runs; nothing the
// model drives runs there). Usage: node cli-network.mjs <egress cli listener host:port> <control app host:port>
// Exit code is the number of probes that did not behave as expected.
import net from "node:net";

const [proxy, controlApp] = process.argv.slice(2);
if (!proxy || !controlApp) {
  console.error("usage: node cli-network.mjs <proxy host:port> <control app host:port>");
  process.exit(2);
}
const [proxyHost, proxyPort] = proxy.split(":");

function request(raw) {
  return new Promise((resolve) => {
    const socket = net.connect(Number(proxyPort), proxyHost, () => socket.write(raw));
    let data = "";
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0] + " " + (/x-quokkabot-decision: (\S+)/i.exec(data)?.[1] ?? ""));
      }
    });
    socket.on("error", (error) => resolve(`error ${error.code}`));
  });
}

function tcp(target) {
  const [host, port] = target.split(":");
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), host, () => {
      socket.destroy();
      resolve("open");
    });
    socket.setTimeout(4000, () => {
      socket.destroy();
      resolve("closed");
    });
    socket.on("error", () => resolve("closed"));
  });
}

const probes = [
  ["other_provider_refused", "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n", / 403 /],
  ["google_api_refused", "CONNECT generativelanguage.googleapis.com:443 HTTP/1.1\r\nHost: generativelanguage.googleapis.com:443\r\n\r\n", / 403 /],
  ["metadata_refused", "CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n", / 403 /],
  ["plain_http_refused_on_cli_listener", "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n", / 40[35] /],
  ["model_provider_allowed_for_the_cli", "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n", / 200 /],
];

let failures = 0;
for (const [name, raw, expected] of probes) {
  const status = await request(raw);
  const pass = expected.test(status);
  if (!pass) failures += 1;
  console.log(JSON.stringify({ check: name, pass, detail: status.trim() }));
}
const app = await tcp(controlApp);
console.log(JSON.stringify({ check: "control_app_port_unreachable", pass: app === "closed", detail: app }));
if (app !== "closed") failures += 1;
process.exit(failures);
