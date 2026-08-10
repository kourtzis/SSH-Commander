import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useSetupTotp, useConfirmTotp, useDisableTotp, 
  useListApiTokens, useCreateApiToken, useRevokeApiToken, 
  getGetMeQueryKey, getListApiTokensQueryKey 
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/auth-context";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Copy, Shield, Key, ShieldCheck, Download, Trash2, ShieldAlert } from "lucide-react";
import { formatDate } from "@/lib/utils";

function TwoFactorSection() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const setupMut = useSetupTotp();
  const confirmMut = useConfirmTotp();
  const disableMut = useDisableTotp();
  
  const [setupData, setSetupData] = useState<any>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const handleSetup = async () => {
    try {
      const res = await setupMut.mutateAsync({} as any);
      setSetupData(res);
    } catch (err: any) {
      toast({ title: "Failed to start 2FA setup", description: err.message, variant: "destructive" });
    }
  };

  const handleConfirm = async () => {
    try {
      const res = await confirmMut.mutateAsync({ data: { code } });
      setRecoveryCodes(res.recoveryCodes);
      toast({ title: "2FA Enabled successfully" });
      await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    } catch (err: any) {
      toast({ title: "Invalid code", description: err.message, variant: "destructive" });
    }
  };

  const handleDisable = async () => {
    try {
      await disableMut.mutateAsync({ data: { password: disablePassword, code: disableCode } });
      toast({ title: "2FA Disabled" });
      setDisableOpen(false);
      setDisablePassword("");
      setDisableCode("");
      await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    } catch (err: any) {
      toast({ title: "Failed to disable 2FA", description: err.message, variant: "destructive" });
    }
  };

  const handleDownload = () => {
    if (!recoveryCodes) return;
    const element = document.createElement("a");
    const file = new Blob([recoveryCodes.join("\n")], { type: "text/plain" });
    element.href = URL.createObjectURL(file);
    element.download = "mikromanager_recovery_codes.txt";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  if (recoveryCodes) {
    return (
      <Card className="border-primary/50 bg-primary/5 glass-panel">
        <CardHeader>
          <CardTitle className="text-primary flex items-center gap-2">
            <ShieldCheck className="w-5 h-5" /> 2FA Enabled Successfully
          </CardTitle>
          <CardDescription className="text-primary/70">
            Save these recovery codes in a secure place. They will <strong className="text-foreground">never be shown again</strong>. Each code can be used once to bypass 2FA if you lose your device.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-4 font-mono text-sm bg-black/60 p-6 rounded-md border border-white/10 text-center">
            {recoveryCodes.map((c, i) => (
              <div key={i} className="tracking-[0.3em] font-bold">{c}</div>
            ))}
          </div>
          <div className="flex gap-4">
            <Button variant="secondary" onClick={handleDownload} className="gap-2">
              <Download className="w-4 h-4" /> Download .txt
            </Button>
            <Button onClick={() => setRecoveryCodes(null)}>I have saved my recovery codes</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (user?.totpEnabled) {
    return (
      <Card className="glass-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-primary"/> Two-Factor Authentication</CardTitle>
          <CardDescription>Your account is protected by an authenticator app.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setDisableOpen(true)}>Disable 2FA</Button>
        </CardContent>

        <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disable Two-Factor Authentication</DialogTitle>
              <DialogDescription>Enter your account password and a current 2FA code to disable 2FA.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Account Password</Label>
                <Input type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Current 2FA Code</Label>
                <Input type="text" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="123456" className="font-mono tracking-widest" maxLength={6} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDisableOpen(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDisable} disabled={!disablePassword || disableCode.length < 6 || disableMut.isPending}>
                Confirm Disable
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    );
  }

  return (
    <Card className="glass-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldAlert className="w-5 h-5 text-muted-foreground"/> Two-Factor Authentication</CardTitle>
        <CardDescription>Add an extra layer of security to your account. Highly recommended for operators.</CardDescription>
      </CardHeader>
      <CardContent>
        {!setupData ? (
          <Button onClick={handleSetup} disabled={setupMut.isPending} className="gap-2"><Key className="w-4 h-4"/> Setup 2FA</Button>
        ) : (
          <div className="space-y-6 max-w-xl">
            <div className="flex flex-col sm:flex-row gap-6 items-start">
              <div className="bg-white p-3 rounded-lg shadow-inner shrink-0">
                <img src={setupData.qrDataUrl} alt="QR Code" className="w-32 h-32" />
              </div>
              <div className="space-y-4 flex-1">
                <div>
                  <h3 className="font-medium text-sm text-foreground">1. Scan the QR code</h3>
                  <p className="text-xs text-muted-foreground mt-1">Use Google Authenticator, Authy, or your password manager.</p>
                </div>
                <div>
                  <h3 className="font-medium text-sm text-foreground">Or enter this code manually:</h3>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="bg-black/40 px-3 py-1.5 rounded text-xs select-all text-primary font-bold border border-white/10">{setupData.secret}</code>
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-3 pt-4 border-t border-white/10">
              <Label>2. Enter the code from your app to verify</Label>
              <div className="flex gap-2">
                <Input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className="font-mono tracking-[0.5em] text-lg max-w-[180px] h-12" maxLength={6} />
                <Button onClick={handleConfirm} disabled={code.length !== 6 || confirmMut.isPending} className="h-12 px-8">Verify & Enable</Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ApiTokensSection() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [showAll, setShowAll] = useState(false);
  
  const queryParams = user?.role === 'admin' && showAll ? { all: true } : undefined;
  const { data: tokens = [], isLoading } = useListApiTokens(queryParams, {
    query: { queryKey: getListApiTokensQueryKey(queryParams) }
  });

  const createMut = useCreateApiToken();
  const revokeMut = useRevokeApiToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [expiresDays, setExpiresDays] = useState<string>("30");
  
  const [newToken, setNewToken] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    try {
      const payload: any = { name: name.trim(), scope };
      if (expiresDays && !isNaN(parseInt(expiresDays))) {
        payload.expiresDays = parseInt(expiresDays);
      }
      const res = await createMut.mutateAsync({ data: payload });
      setNewToken(res.token);
      setCreateOpen(false);
      setName("");
      setScope("read");
      setExpiresDays("30");
      await queryClient.invalidateQueries({ queryKey: getListApiTokensQueryKey(queryParams) });
    } catch (err: any) {
      toast({ title: "Failed to create token", description: err.message, variant: "destructive" });
    }
  };

  const handleRevoke = async (id: number) => {
    const ok = await confirm({ title: "Revoke Token", description: "Any scripts using this token will fail immediately. This action cannot be undone.", variant: "destructive" });
    if (!ok) return;
    try {
      await revokeMut.mutateAsync({ id });
      toast({ title: "Token revoked" });
      await queryClient.invalidateQueries({ queryKey: getListApiTokensQueryKey(queryParams) });
    } catch (err: any) {
      toast({ title: "Failed to revoke token", description: err.message, variant: "destructive" });
    }
  };

  const getTokenStatus = (t: any) => {
    if (t.revokedAt) return <Badge variant="destructive" className="border-0">Revoked</Badge>;
    if (t.expiresAt && new Date(t.expiresAt) < new Date()) return <Badge variant="outline" className="text-muted-foreground">Expired</Badge>;
    return <Badge variant="default" className="bg-primary/20 text-primary hover:bg-primary/30 border-0">Active</Badge>;
  };

  return (
    <div className="space-y-4">
      {newToken && (
        <Card className="border-primary/50 bg-primary/5 mb-6 glass-panel">
          <CardHeader>
            <CardTitle className="text-primary flex items-center gap-2"><Key className="w-5 h-5"/> Token Created</CardTitle>
            <CardDescription className="text-primary/70">
              Copy your personal access token now. You won't be able to see it again!
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input value={newToken} readOnly className="font-mono text-sm tracking-wide bg-black/40 border-white/10" />
              <Button variant="secondary" onClick={() => {
                navigator.clipboard.writeText(newToken);
                toast({ title: "Copied to clipboard" });
              }} className="gap-2 shrink-0">
                <Copy className="w-4 h-4" /> Copy
              </Button>
            </div>
            <Button variant="outline" onClick={() => setNewToken(null)}>I have copied it</Button>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between items-end mb-2 px-1">
        <p className="text-sm text-muted-foreground max-w-xl">Personal access tokens bypass the browser session and are meant for automation scripts mapping to your account.</p>
        <div className="flex items-center gap-6">
          {user?.role === 'admin' && (
            <label className="flex items-center gap-2 cursor-pointer bg-black/20 px-3 py-1.5 rounded-full border border-white/5">
              <Checkbox checked={showAll} onCheckedChange={(c) => setShowAll(Boolean(c))} />
              <span className="text-xs font-medium uppercase tracking-wide">Show all users</span>
            </label>
          )}
          <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-2"><Key className="w-4 h-4"/> New Token</Button>
        </div>
      </div>

      <Card className="glass-panel overflow-hidden">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b border-white/5 bg-black/20">
              <tr>
                <th className="px-6 py-3 text-left">Name</th>
                {showAll && <th className="px-6 py-3 text-left">User</th>}
                <th className="px-6 py-3 text-left">Prefix</th>
                <th className="px-6 py-3 text-left">Scope</th>
                <th className="px-6 py-3 text-left">Expires</th>
                <th className="px-6 py-3 text-left">Status</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {tokens.map((t: any) => {
                const isActive = !t.revokedAt && (!t.expiresAt || new Date(t.expiresAt) > new Date());
                return (
                  <tr key={t.id} className={`hover:bg-white/[0.02] ${!isActive ? "opacity-60" : ""}`}>
                    <td className="px-6 py-4 font-medium">{t.name}</td>
                    {showAll && <td className="px-6 py-4 text-muted-foreground">{t.username}</td>}
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">{t.prefix}••••••••</td>
                    <td className="px-6 py-4">
                      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{t.scope}</Badge>
                    </td>
                    <td className="px-6 py-4 text-muted-foreground">
                      {t.expiresAt ? formatDate(t.expiresAt).split(' ')[0] : "Never"}
                    </td>
                    <td className="px-6 py-4">
                      {getTokenStatus(t)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {isActive && (
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10 h-8" onClick={() => handleRevoke(t.id)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {tokens.length === 0 && !isLoading && (
                <tr><td colSpan={showAll ? 7 : 6} className="px-6 py-8 text-center text-muted-foreground">No API tokens found.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create API Token</DialogTitle>
            <DialogDescription>Generates a bearer token scoped to your user permissions.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Token Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. CI/CD Pipeline" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Scope</Label>
                <select className="flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm" value={scope} onChange={(e) => setScope(e.target.value as any)}>
                  <option value="read">Read Only</option>
                  <option value="write">Full Access</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Expiration</Label>
                <select className="flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm" value={expiresDays} onChange={(e) => setExpiresDays(e.target.value)}>
                  <option value="7">7 Days</option>
                  <option value="30">30 Days</option>
                  <option value="90">90 Days</option>
                  <option value="365">1 Year</option>
                  <option value="">Never Expire</option>
                </select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createMut.isPending}>Generate Token</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <Shield className="w-7 h-7 text-primary" />
          Security Center
        </h1>
        <p className="text-muted-foreground mt-1 text-sm max-w-2xl">
          Manage your personal account security settings and automation tokens.
        </p>
      </div>
      <Tabs defaultValue="2fa" className="w-full">
        <TabsList className="bg-black/20">
          <TabsTrigger value="2fa">Two-Factor Authentication</TabsTrigger>
          <TabsTrigger value="tokens">API Tokens</TabsTrigger>
        </TabsList>
        <TabsContent value="2fa" className="mt-6"><TwoFactorSection /></TabsContent>
        <TabsContent value="tokens" className="mt-6"><ApiTokensSection /></TabsContent>
      </Tabs>
    </div>
  );
}
