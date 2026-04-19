// ─── Per-Device Terminal Page ──────────────────────────────────────
// A lightweight in-browser SSH terminal for a single device. Streams output
// from the API server's SSE endpoint and forwards typed input via the POST
// endpoint. We deliberately use a plain <pre> + <input> rather than xterm.js
// to keep the bundle small — for short interactive operations this is fine,
// and it matches the existing interactive-job UI style.

import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useListRouters, customFetch } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Terminal as TerminalIcon, ArrowLeft, Plug, PlugZap, X } from "lucide-react";

export default function RouterTerminal() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id);
  const { data: routers = [] } = useListRouters();
  const router = routers.find((r) => r.id === id);

  const [output, setOutput] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const eventSrcRef = useRef<EventSource | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom whenever output grows
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const connect = () => {
    setOutput("");
    setError(null);
    const es = new EventSource(`/api/routers/${id}/terminal`, { withCredentials: true });
    eventSrcRef.current = es;
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === "data" && typeof evt.data === "string") {
          setOutput((prev) => prev + evt.data);
        } else if (evt.type === "error") {
          setError(String(evt.message || "session error"));
        } else if (evt.type === "closed") {
          setConnected(false);
          es.close();
        }
      } catch {
        // Some servers send raw text; treat as data.
        setOutput((prev) => prev + e.data);
      }
    };
    es.onerror = () => {
      setError("Connection lost");
      setConnected(false);
      es.close();
    };
  };

  const disconnect = () => {
    eventSrcRef.current?.close();
    eventSrcRef.current = null;
    setConnected(false);
  };

  useEffect(() => {
    return () => { eventSrcRef.current?.close(); };
  }, []);

  const sendInput = async (value: string) => {
    if (!connected) return;
    try {
      const baseUrl = import.meta.env.BASE_URL || "/";
      await customFetch(`${baseUrl}api/routers/${id}/terminal/input`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: value }),
      });
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input) return;
    setOutput((prev) => prev + `> ${input}\n`);
    await sendInput(input);
    setInput("");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/routers">
            <button className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2">
              <ArrowLeft className="w-3 h-3" /> back to devices
            </button>
          </Link>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <TerminalIcon className="w-7 h-7 text-primary" />
            {router?.name ?? `Device #${id}`}
          </h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">
            {router ? `${router.sshUsername}@${router.ipAddress}:${router.sshPort}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {connected ? (
            <Button variant="outline" onClick={disconnect} className="gap-2" data-testid="disconnect-button">
              <X className="w-4 h-4" /> Disconnect
            </Button>
          ) : (
            <Button onClick={connect} className="gap-2" data-testid="connect-button">
              <PlugZap className="w-4 h-4" /> Connect
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-black/40">
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
              <span className="text-muted-foreground">{connected ? "connected" : "disconnected"}</span>
            </div>
            {error && <span className="text-xs text-destructive">{error}</span>}
          </div>
          <pre
            ref={outputRef}
            className="bg-black text-green-300 p-4 font-mono text-xs h-[480px] overflow-auto whitespace-pre-wrap"
            data-testid="terminal-output"
          >
            {output || (connected ? "Waiting for output…\n" : "Click Connect to open an SSH session.\n")}
          </pre>
          <form onSubmit={handleSubmit} className="border-t border-white/5 p-2 flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={connected ? "Type a command and press Enter…" : "Not connected"}
              disabled={!connected}
              className="font-mono"
              data-testid="terminal-input"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={!connected || !input} className="gap-2">
              <Plug className="w-4 h-4" /> Send
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Tip: This terminal opens a single short-lived SSH session. For long-running commands or scripts that touch many devices, use{" "}
        <Link href="/jobs/new"><a className="underline hover:text-primary">Batch Jobs</a></Link>.
      </p>
    </div>
  );
}
