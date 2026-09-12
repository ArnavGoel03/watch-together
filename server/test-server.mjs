import { setTimeout, clearTimeout } from "node:timers";

// Tests wait for their own child's listener, never an unrelated process on a fixed port.
export function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stdout?.resume();
    const remember = (data) => { stderr = (stderr + data.toString()).slice(-4096); };
    child.stderr?.on("data", remember);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Server did not start: ${stderr}`));
    }, 3000);
    const onExit = (code) => finish(new Error(`Server exited before listening (${code}): ${stderr}`));
    const onError = (error) => finish(error);
    const onMessage = (message) => {
      if (message?.type === "listening" && Number.isInteger(message.port) && message.port > 0) {
        finish(null, message.port);
      }
    };
    function finish(error, port) {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      child.off("message", onMessage);
      child.stderr?.off("data", remember);
      child.stderr?.resume();
      if (error) reject(error); else resolve(port);
    }
    child.once("exit", onExit);
    child.once("error", onError);
    child.on("message", onMessage);
  });
}
