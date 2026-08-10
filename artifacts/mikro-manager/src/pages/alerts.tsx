import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useListAlertChannels, useCreateAlertChannel, useUpdateAlertChannel, useDeleteAlertChannel, useTestAlertChannel, getListAlertChannelsQueryKey,
  useListAlertRules, useCreateAlertRule, useUpdateAlertRule, useDeleteAlertRule, getListAlertRulesQueryKey,
  useListAlertEvents, getListAlertEventsQueryKey,
  useListRouters, getListRoutersQueryKey,
  useListGroups, getListGroupsQueryKey
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/confirm-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BellRing, Plus, Edit2, Trash2, Send, Activity, ChevronLeft, ChevronRight, CheckCircle2, XCircle } from "lucide-react";
import { formatDate } from "@/lib/utils";

const EVENT_TYPES = [
  "device_down", "device_up", "job_failed", "job_completed", 
  "schedule_failed", "backup_failed", "drift_detected", 
  "upgrade_completed", "upgrade_failed"
];

function AlertChannelsTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const { data: channels = [], isLoading } = useListAlertChannels({ query: { queryKey: getListAlertChannelsQueryKey() }});
  
  const createMut = useCreateAlertChannel();
  const updateMut = useUpdateAlertChannel();
  const deleteMut = useDeleteAlertChannel();
  const testMut = useTestAlertChannel();

  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<"telegram"|"email"|"webhook">("telegram");
  const [enabled, setEnabled] = useState(true);

  // Telegram
  const [tgBotToken, setTgBotToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  
  // Email
  const [emHost, setEmHost] = useState("");
  const [emPort, setEmPort] = useState("587");
  const [emSecure, setEmSecure] = useState(false);
  const [emUsername, setEmUsername] = useState("");
  const [emPassword, setEmPassword] = useState("");
  const [emFrom, setEmFrom] = useState("");
  const [emTo, setEmTo] = useState("");

  // Webhook
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");

  const handleOpenDialog = (c?: any) => {
    if (c) {
      setEditing(c);
      setName(c.name);
      setType(c.type);
      setEnabled(c.enabled);
      
      setTgBotToken("");
      setTgChatId(c.type === 'telegram' ? c.config.chatId || "" : "");

      setEmHost(c.type === 'email' ? c.config.host || "" : "");
      setEmPort(c.type === 'email' ? String(c.config.port || "587") : "587");
      setEmSecure(c.type === 'email' ? c.config.secure || false : false);
      setEmUsername(c.type === 'email' ? c.config.username || "" : "");
      setEmPassword("");
      setEmFrom(c.type === 'email' ? c.config.from || "" : "");
      setEmTo(c.type === 'email' ? c.config.to || "" : "");

      setWhUrl(c.type === 'webhook' ? c.config.url || "" : "");
      setWhSecret("");
    } else {
      setEditing(null);
      setName("");
      setType("telegram");
      setEnabled(true);
      setTgBotToken(""); setTgChatId("");
      setEmHost(""); setEmPort("587"); setEmSecure(false); setEmUsername(""); setEmPassword(""); setEmFrom(""); setEmTo("");
      setWhUrl(""); setWhSecret("");
    }
    setIsOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }

    let config: any = {};
    if (type === 'telegram') {
      if (!tgChatId) {
        toast({ title: "Chat ID is required", variant: "destructive" });
        return;
      }
      config = { chatId: tgChatId };
      if (tgBotToken) config.botToken = tgBotToken;
    } else if (type === 'email') {
      if (!emHost || !emFrom || !emTo) {
        toast({ title: "Host, From, and To are required", variant: "destructive" });
        return;
      }
      config = {
        host: emHost,
        port: parseInt(emPort) || 587,
        secure: emSecure,
        username: emUsername,
        from: emFrom,
        to: emTo,
      };
      if (emPassword) config.password = emPassword;
    } else if (type === 'webhook') {
      if (!whUrl) {
        toast({ title: "Webhook URL is required", variant: "destructive" });
        return;
      }
      config = { url: whUrl };
      if (whSecret) config.secret = whSecret;
    }

    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, data: { name: name.trim(), enabled, config } });
        toast({ title: "Channel updated" });
      } else {
        await createMut.mutateAsync({ data: { name: name.trim(), type, enabled, config } as any });
        toast({ title: "Channel created" });
      }
      await queryClient.invalidateQueries({ queryKey: getListAlertChannelsQueryKey() });
      setIsOpen(false);
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({ title: "Delete Channel", description: "Are you sure? Alert rules using this channel will no longer send notifications here.", variant: "destructive" });
    if (!ok) return;
    try {
      await deleteMut.mutateAsync({ id });
      toast({ title: "Channel deleted" });
      await queryClient.invalidateQueries({ queryKey: getListAlertChannelsQueryKey() });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    }
  };

  const handleTest = async (id: number) => {
    try {
      const res = await testMut.mutateAsync({ id } as any);
      if (res.success) {
        toast({ title: "Test successful", description: "A test message was delivered." });
      } else {
        toast({ title: "Test failed", description: res.error, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Test error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button onClick={() => handleOpenDialog()} className="gap-2"><Plus className="w-4 h-4"/> New Channel</Button>
        </div>
      )}
      <Card className="glass-panel overflow-hidden">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b border-white/5 bg-black/20">
              <tr>
                <th className="px-6 py-3 text-left">Name</th>
                <th className="px-6 py-3 text-left">Type</th>
                <th className="px-6 py-3 text-left">Status</th>
                <th className="px-6 py-3 text-left">Last Used</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {channels.map((c: any) => (
                <tr key={c.id} className="hover:bg-white/[0.02]">
                  <td className="px-6 py-4">
                    <div className="font-medium text-foreground">{c.name}</div>
                    {c.lastError && <div className="text-xs text-destructive mt-1 max-w-xs truncate" title={c.lastError}>Error: {c.lastError}</div>}
                  </td>
                  <td className="px-6 py-4">
                    <Badge variant="outline" className="capitalize">{c.type}</Badge>
                  </td>
                  <td className="px-6 py-4">
                    <Badge variant={c.enabled ? "default" : "secondary"} className={c.enabled ? "bg-primary/20 text-primary border-0" : ""}>
                      {c.enabled ? "Active" : "Disabled"}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {c.lastUsedAt ? formatDate(c.lastUsedAt) : "Never"}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => handleTest(c.id)} disabled={!isAdmin || testMut.isPending}>
                        <Send className="w-3.5 h-3.5" /> Test
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleOpenDialog(c)} disabled={!isAdmin}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(c.id)} disabled={!isAdmin}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {channels.length === 0 && !isLoading && (
                <tr><td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">No channels configured.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Channel" : "New Channel"}</DialogTitle>
            <DialogDescription>Where alerts get delivered — Telegram, email (SMTP), or a webhook receiver.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto px-1">
            <div className="space-y-2">
              <Label>Channel Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Ops Telegram Group" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Channel Type</Label>
                <select className="flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm disabled:opacity-50" value={type} onChange={(e) => setType(e.target.value as any)} disabled={!!editing}>
                  <option value="telegram">Telegram</option>
                  <option value="email">Email</option>
                  <option value="webhook">Webhook</option>
                </select>
              </div>
              <div className="space-y-2 pt-8">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={enabled} onCheckedChange={(c) => setEnabled(Boolean(c))} />
                  <span className="text-sm font-medium">Enabled</span>
                </label>
              </div>
            </div>

            <div className="border-t border-white/5 pt-4 mt-2 space-y-4">
              {type === 'telegram' && (
                <>
                  <div className="space-y-2">
                    <Label>Bot Token {editing && editing.config?.botTokenSet && <span className="text-xs text-muted-foreground font-normal">(leave blank to keep)</span>}</Label>
                    <Input type="password" value={tgBotToken} onChange={e => setTgBotToken(e.target.value)} placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
                  </div>
                  <div className="space-y-2">
                    <Label>Chat ID</Label>
                    <Input value={tgChatId} onChange={e => setTgChatId(e.target.value)} placeholder="-1001234567890" />
                  </div>
                </>
              )}
              {type === 'email' && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-2 col-span-2">
                      <Label>SMTP Host</Label>
                      <Input value={emHost} onChange={e => setEmHost(e.target.value)} placeholder="smtp.example.com" />
                    </div>
                    <div className="space-y-2">
                      <Label>Port</Label>
                      <Input type="number" value={emPort} onChange={e => setEmPort(e.target.value)} placeholder="587" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Username</Label>
                      <Input value={emUsername} onChange={e => setEmUsername(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Password {editing && editing.config?.passwordSet && <span className="text-xs text-muted-foreground font-normal">(keep blank)</span>}</Label>
                      <Input type="password" value={emPassword} onChange={e => setEmPassword(e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>From Address</Label>
                      <Input value={emFrom} onChange={e => setEmFrom(e.target.value)} placeholder="alerts@example.com" />
                    </div>
                    <div className="space-y-2">
                      <Label>To Address</Label>
                      <Input value={emTo} onChange={e => setEmTo(e.target.value)} placeholder="ops-team@example.com" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <Checkbox checked={emSecure} onCheckedChange={c => setEmSecure(Boolean(c))} />
                    <span className="text-sm">Use TLS / Secure Connection</span>
                  </label>
                </>
              )}
              {type === 'webhook' && (
                <>
                  <div className="space-y-2">
                    <Label>Webhook URL</Label>
                    <Input value={whUrl} onChange={e => setWhUrl(e.target.value)} placeholder="https://api.example.com/webhook" />
                  </div>
                  <div className="space-y-2">
                    <Label>Secret Token (Optional) {editing && editing.config?.secretSet && <span className="text-xs text-muted-foreground font-normal">(leave blank to keep)</span>}</Label>
                    <Input type="password" value={whSecret} onChange={e => setWhSecret(e.target.value)} placeholder="Signature verification secret" />
                  </div>
                </>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AlertRulesTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useListAlertRules({ query: { queryKey: getListAlertRulesQueryKey() }});
  const { data: channels = [] } = useListAlertChannels({ query: { queryKey: getListAlertChannelsQueryKey() }});
  const { data: routers = [] } = useListRouters({ query: { queryKey: getListRoutersQueryKey() }});
  const { data: groups = [] } = useListGroups({ query: { queryKey: getListGroupsQueryKey() }});

  const createMut = useCreateAlertRule();
  const updateMut = useUpdateAlertRule();
  const deleteMut = useDeleteAlertRule();

  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const [name, setName] = useState("");
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [routerIds, setRouterIds] = useState<number[]>([]);
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [channelIds, setChannelIds] = useState<number[]>([]);
  const [cooldownMinutes, setCooldownMinutes] = useState("60");
  const [enabled, setEnabled] = useState(true);

  const handleOpenDialog = (r?: any) => {
    if (r) {
      setEditing(r);
      setName(r.name);
      setEventTypes(r.eventTypes || []);
      setRouterIds(r.routerIds || []);
      setGroupIds(r.groupIds || []);
      setChannelIds(r.channelIds || []);
      setCooldownMinutes(String(r.cooldownMinutes ?? 60));
      setEnabled(r.enabled);
    } else {
      setEditing(null);
      setName("");
      setEventTypes([]);
      setRouterIds([]);
      setGroupIds([]);
      setChannelIds([]);
      setCooldownMinutes("60");
      setEnabled(true);
    }
    setIsOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (eventTypes.length === 0) {
      toast({ title: "Select at least one event type", variant: "destructive" });
      return;
    }
    if (channelIds.length === 0) {
      toast({ title: "Select at least one channel", variant: "destructive" });
      return;
    }

    const payload = {
      name: name.trim(),
      eventTypes: eventTypes as any[],
      routerIds,
      groupIds,
      channelIds,
      cooldownMinutes: parseInt(cooldownMinutes) || 0,
      enabled
    };

    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, data: payload });
        toast({ title: "Rule updated" });
      } else {
        await createMut.mutateAsync({ data: payload });
        toast({ title: "Rule created" });
      }
      await queryClient.invalidateQueries({ queryKey: getListAlertRulesQueryKey() });
      setIsOpen(false);
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({ title: "Delete Rule", description: "Are you sure you want to delete this alert rule?", variant: "destructive" });
    if (!ok) return;
    try {
      await deleteMut.mutateAsync({ id });
      toast({ title: "Rule deleted" });
      await queryClient.invalidateQueries({ queryKey: getListAlertRulesQueryKey() });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button onClick={() => handleOpenDialog()} className="gap-2"><Plus className="w-4 h-4"/> New Rule</Button>
        </div>
      )}
      <Card className="glass-panel overflow-hidden">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b border-white/5 bg-black/20">
              <tr>
                <th className="px-6 py-3 text-left">Name</th>
                <th className="px-6 py-3 text-left">Events</th>
                <th className="px-6 py-3 text-left">Targets</th>
                <th className="px-6 py-3 text-left">Channels</th>
                <th className="px-6 py-3 text-left">Status</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rules.map((r: any) => (
                <tr key={r.id} className="hover:bg-white/[0.02]">
                  <td className="px-6 py-4 font-medium text-foreground">{r.name}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {r.eventTypes.slice(0, 2).map((et: string) => (
                        <Badge key={et} variant="outline" className="text-[10px] bg-primary/5 text-primary border-primary/20">{et}</Badge>
                      ))}
                      {r.eventTypes.length > 2 && <Badge variant="outline" className="text-[10px]">+{r.eventTypes.length - 2}</Badge>}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {r.routerIds.length === 0 && r.groupIds.length === 0 ? (
                      <span className="text-muted-foreground">All devices</span>
                    ) : (
                      <div className="flex gap-2 text-xs">
                        {r.routerIds.length > 0 && <span>{r.routerIds.length} routers</span>}
                        {r.groupIds.length > 0 && <span>{r.groupIds.length} groups</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-muted-foreground">{r.channelIds.length} channels</td>
                  <td className="px-6 py-4">
                    <Badge variant={r.enabled ? "default" : "secondary"} className={r.enabled ? "bg-primary/20 text-primary border-0" : ""}>
                      {r.enabled ? "Active" : "Disabled"}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleOpenDialog(r)} disabled={!isAdmin}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(r.id)} disabled={!isAdmin}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {rules.length === 0 && !isLoading && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">No alert rules defined.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Rule" : "New Rule"}</DialogTitle>
            <DialogDescription>Which events trigger notifications, through which channels, and how often.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4 max-h-[65vh] overflow-y-auto px-1">
            <div className="flex gap-4">
              <div className="space-y-2 flex-1">
                <Label>Rule Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Critical Failures" />
              </div>
              <div className="space-y-2 pt-8">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={enabled} onCheckedChange={(c) => setEnabled(Boolean(c))} />
                  <span className="text-sm font-medium">Enabled</span>
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Event Types</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 border border-white/5 p-3 rounded-md bg-black/20">
                {EVENT_TYPES.map(et => (
                  <label key={et} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={eventTypes.includes(et)} onCheckedChange={(c) => {
                      if (c) setEventTypes([...eventTypes, et]);
                      else setEventTypes(eventTypes.filter(x => x !== et));
                    }} />
                    <span className="font-mono text-xs text-muted-foreground truncate">{et}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Target Routers (Optional)</Label>
                <div className="border border-white/5 rounded-md h-32 overflow-y-auto p-2 bg-black/20 space-y-1">
                  {routers.map((r: any) => (
                    <label key={r.id} className="flex items-center gap-2 text-sm hover:bg-white/5 p-1 rounded cursor-pointer">
                      <Checkbox checked={routerIds.includes(r.id)} onCheckedChange={(c) => {
                        if (c) setRouterIds([...routerIds, r.id]);
                        else setRouterIds(routerIds.filter(x => x !== r.id));
                      }} />
                      <span className="truncate">{r.name}</span>
                    </label>
                  ))}
                  {routers.length === 0 && <div className="text-xs text-muted-foreground p-2">No routers</div>}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Target Groups (Optional)</Label>
                <div className="border border-white/5 rounded-md h-32 overflow-y-auto p-2 bg-black/20 space-y-1">
                  {groups.map((g: any) => (
                    <label key={g.id} className="flex items-center gap-2 text-sm hover:bg-white/5 p-1 rounded cursor-pointer">
                      <Checkbox checked={groupIds.includes(g.id)} onCheckedChange={(c) => {
                        if (c) setGroupIds([...groupIds, g.id]);
                        else setGroupIds(groupIds.filter(x => x !== g.id));
                      }} />
                      <span className="truncate">{g.name}</span>
                    </label>
                  ))}
                  {groups.length === 0 && <div className="text-xs text-muted-foreground p-2">No groups</div>}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">Leave targets empty to match events for all devices.</p>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Delivery Channels</Label>
                <div className="border border-white/5 rounded-md h-32 overflow-y-auto p-2 bg-black/20 space-y-1">
                  {channels.map((c: any) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm hover:bg-white/5 p-1 rounded cursor-pointer">
                      <Checkbox checked={channelIds.includes(c.id)} onCheckedChange={(checked) => {
                        if (checked) setChannelIds([...channelIds, c.id]);
                        else setChannelIds(channelIds.filter(x => x !== c.id));
                      }} />
                      <span className="flex-1 truncate">{c.name}</span>
                      <Badge variant="outline" className="text-[10px] px-1">{c.type}</Badge>
                    </label>
                  ))}
                  {channels.length === 0 && <div className="text-xs text-muted-foreground p-2">No channels configured</div>}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Cooldown (Minutes)</Label>
                <Input type="number" value={cooldownMinutes} onChange={e => setCooldownMinutes(e.target.value)} />
                <p className="text-xs text-muted-foreground">Suppress repeats of the same event type + subject for this duration.</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AlertHistoryTab() {
  const [page, setPage] = useState(1);
  const limit = 50;
  const params = { limit, offset: (page - 1) * limit };
  const { data: pageData, isLoading } = useListAlertEvents(params, {
    query: { queryKey: getListAlertEventsQueryKey(params), placeholderData: (prev: any) => prev }
  });

  const items = pageData?.items || [];
  const total = pageData?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      <Card className="glass-panel overflow-hidden">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b border-white/5 bg-black/20">
              <tr>
                <th className="px-6 py-3 text-left">Timestamp</th>
                <th className="px-6 py-3 text-left">Event Type</th>
                <th className="px-6 py-3 text-left">Rule & Subject</th>
                <th className="px-6 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.map((item: any) => (
                <tr key={item.id} className="hover:bg-white/[0.02]">
                  <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                    {formatDate(item.createdAt)}
                  </td>
                  <td className="px-6 py-4">
                    <Badge variant="outline" className="font-mono text-[10px] bg-primary/5 text-primary border-primary/20">{item.eventType}</Badge>
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-medium text-foreground">{item.subject}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 max-w-sm truncate" title={item.message}>
                      <span className="font-semibold text-foreground/60 mr-1">[{item.ruleName}]</span>
                      {item.message}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {item.status === 'sent' && <Badge className="bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-0"><CheckCircle2 className="w-3 h-3 mr-1"/> Sent</Badge>}
                    {item.status === 'failed' && <Badge variant="destructive" className="border-0"><XCircle className="w-3 h-3 mr-1"/> Failed</Badge>}
                    {item.status === 'suppressed' && <Badge variant="outline" className="text-muted-foreground"><Activity className="w-3 h-3 mr-1"/> Suppressed</Badge>}
                    {item.error && <p className="text-xs text-destructive mt-1 max-w-xs truncate" title={item.error}>{item.error}</p>}
                  </td>
                </tr>
              ))}
              {items.length === 0 && !isLoading && (
                <tr><td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">No alerts history available.</td></tr>
              )}
            </tbody>
          </table>
          
          {totalPages > 1 && (
            <div className="p-4 border-t border-white/5 flex items-center justify-between text-sm">
              <div className="text-muted-foreground">
                Showing {items.length} of {total} events
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <div className="flex items-center px-4 font-mono text-xs">
                  {page} / {totalPages}
                </div>
                <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AlertsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <BellRing className="w-7 h-7 text-primary" />
          Alerts & Notifications
        </h1>
        <p className="text-muted-foreground mt-1 text-sm max-w-2xl">
          Automate notifications for offline devices, failed jobs, configuration drift, and scheduled backup outcomes.
        </p>
      </div>
      <Tabs defaultValue="rules" className="w-full">
        <TabsList className="bg-black/20">
          <TabsTrigger value="rules">Alert Rules</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="mt-6"><AlertRulesTab /></TabsContent>
        <TabsContent value="channels" className="mt-6"><AlertChannelsTab /></TabsContent>
        <TabsContent value="history" className="mt-6"><AlertHistoryTab /></TabsContent>
      </Tabs>
    </div>
  );
}
