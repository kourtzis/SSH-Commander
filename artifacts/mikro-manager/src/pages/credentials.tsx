// ─── Credentials Admin Page ───────────────────────────────────────
// Admin-only CRUD UI for reusable SSH credential profiles. Each profile
// holds a username/password (and optional enable password) that devices can
// reference instead of duplicating credentials per-device. Profiles can also
// declare an optional jump host (bastion).
//
// Sensitive fields are write-only — the API returns `hasPassword` /
// `hasEnablePassword` booleans so we can show "set / not set" without
// echoing the secret back to the browser.

import { useState } from "react";
import {
  useListCredentialProfiles,
  useCreateCredentialProfile,
  useUpdateCredentialProfile,
  useDeleteCredentialProfile,
  getListCredentialProfilesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useConfirm } from "@/components/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, KeyRound, Edit2, Trash2, ShieldAlert } from "lucide-react";

export default function Credentials() {
  const { user } = useAuth();
  const { data: profiles = [], isLoading } = useListCredentialProfiles({
    query: { enabled: user?.role === "admin" },
  });
  const createMut = useCreateCredentialProfile();
  const updateMut = useUpdateCredentialProfile();
  const deleteMut = useDeleteCredentialProfile();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  // Form state — kept as plain useState (rather than react-hook-form) since
  // it's a small dialog and we want explicit "leave password blank to keep
  // current" semantics on edit.
  const [name, setName] = useState("");
  const [sshUsername, setSshUsername] = useState("admin");
  const [sshPassword, setSshPassword] = useState("");
  const [enablePassword, setEnablePassword] = useState("");
  const [jumpHostId, setJumpHostId] = useState<string>("");
  const [jumpHost, setJumpHost] = useState("");
  const [jumpPort, setJumpPort] = useState<string>("");
  const [description, setDescription] = useState("");

  if (user?.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <ShieldAlert className="w-16 h-16 text-destructive mb-4" />
        <h2 className="text-2xl font-bold">Access Denied</h2>
        <p className="text-muted-foreground mt-2">You must be an administrator to manage credentials.</p>
      </div>
    );
  }

  const openDialog = (p?: any) => {
    if (p) {
      setEditing(p);
      setName(p.name);
      setSshUsername(p.sshUsername);
      setSshPassword("");
      setEnablePassword("");
      setJumpHostId(p.jumpHostId ? String(p.jumpHostId) : "");
      setJumpHost(p.jumpHost ?? "");
      setJumpPort(p.jumpPort ? String(p.jumpPort) : "");
      setDescription(p.description ?? "");
    } else {
      setEditing(null);
      setName("");
      setSshUsername("admin");
      setSshPassword("");
      setEnablePassword("");
      setJumpHostId("");
      setJumpHost("");
      setJumpPort("");
      setDescription("");
    }
    setIsOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim() || !sshUsername.trim()) {
      toast({ title: "Name and SSH username are required", variant: "destructive" });
      return;
    }
    const payload: any = {
      name: name.trim(),
      sshUsername: sshUsername.trim(),
      description: description.trim() || null,
      jumpHostId: jumpHostId ? parseInt(jumpHostId) : null,
      jumpHost: jumpHost.trim() || null,
      jumpPort: jumpPort ? parseInt(jumpPort) : null,
    };
    // Only send password fields when non-empty so editing without retyping
    // them preserves the existing secret.
    if (sshPassword) payload.sshPassword = sshPassword;
    if (enablePassword) payload.enablePassword = enablePassword;

    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, data: payload });
        toast({ title: "Profile updated" });
      } else {
        if (!sshPassword) {
          toast({ title: "Password required for new profiles", variant: "destructive" });
          return;
        }
        await createMut.mutateAsync({ data: payload });
        toast({ title: "Profile created" });
      }
      await queryClient.invalidateQueries({ queryKey: getListCredentialProfilesQueryKey() });
      setIsOpen(false);
    } catch (err: any) {
      toast({ title: "Save failed", description: String(err?.message || err), variant: "destructive" });
    }
  };

  const handleDelete = async (p: any) => {
    const ok = await confirm({
      title: `Delete credential profile "${p.name}"?`,
      description: "Devices that reference this profile will fall back to their inline credentials.",
      variant: "destructive",
    });
    if (!ok) return;
    await deleteMut.mutateAsync({ id: p.id });
    await queryClient.invalidateQueries({ queryKey: getListCredentialProfilesQueryKey() });
    toast({ title: "Profile deleted" });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <KeyRound className="w-7 h-7 text-primary" />
            Credential Profiles
          </h1>
          <p className="text-muted-foreground mt-1">
            Reusable SSH credentials for devices. Profiles can declare an optional jump host (bastion).
          </p>
        </div>
        <Button onClick={() => openDialog()} className="gap-2" data-testid="new-credential-button">
          <Plus className="w-4 h-4" /> New Profile
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : profiles.length === 0 ? (
            <div className="p-12 text-center">
              <KeyRound className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">No credential profiles yet.</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Create one to share credentials across many devices.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground border-b border-white/5">
                  <tr>
                    <th className="px-6 py-3 text-left">Name</th>
                    <th className="px-6 py-3 text-left">User</th>
                    <th className="px-6 py-3 text-left">Secrets</th>
                    <th className="px-6 py-3 text-left">Jump Host</th>
                    <th className="px-6 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {profiles.map((p) => (
                    <tr key={p.id} className="hover:bg-white/[0.02]">
                      <td className="px-6 py-4 font-medium">
                        {p.name}
                        {p.description && <p className="text-xs text-muted-foreground font-normal mt-0.5">{p.description}</p>}
                      </td>
                      <td className="px-6 py-4 font-mono text-muted-foreground">{p.sshUsername}</td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={p.hasPassword ? "default" : "outline"}>
                            {p.hasPassword ? "password set" : "no password"}
                          </Badge>
                          {p.hasEnablePassword && <Badge variant="outline">enable</Badge>}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">
                        {p.jumpHostId
                          ? <span className="font-mono text-xs">profile #{p.jumpHostId}</span>
                          : p.jumpHost
                          ? <span className="font-mono text-xs">{p.jumpHost}{p.jumpPort ? `:${p.jumpPort}` : ""}</span>
                          : <span className="text-muted-foreground/40">none</span>}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" onClick={() => openDialog(p)} data-testid={`edit-credential-${p.id}`}>
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(p)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Profile" : "New Credential Profile"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Profile Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Datacenter Mikrotiks" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>SSH Username</Label>
                <Input value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>SSH Password {editing && <span className="text-muted-foreground text-xs">(leave blank to keep)</span>}</Label>
                <Input type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} placeholder="••••••••" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Enable / Sudo Password (optional)</Label>
              <Input type="password" value={enablePassword} onChange={(e) => setEnablePassword(e.target.value)} placeholder="For Cisco enable mode or sudo elevation" />
            </div>
            <div className="border-t border-white/5 pt-4 space-y-4">
              <p className="text-xs uppercase text-muted-foreground tracking-wider">Jump Host (optional)</p>
              <div className="space-y-2">
                <Label>Reference another profile (jumpHostId)</Label>
                <select
                  className="w-full bg-background border border-white/10 rounded-md px-3 py-2 text-sm"
                  value={jumpHostId}
                  onChange={(e) => setJumpHostId(e.target.value)}
                >
                  <option value="">— none —</option>
                  {profiles
                    .filter((p) => !editing || p.id !== editing.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-2 col-span-2">
                  <Label>Or inline jump host</Label>
                  <Input value={jumpHost} onChange={(e) => setJumpHost(e.target.value)} placeholder="bastion.example.com" />
                </div>
                <div className="space-y-2">
                  <Label>Port</Label>
                  <Input type="number" value={jumpPort} onChange={(e) => setJumpPort(e.target.value)} placeholder="22" />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending} data-testid="save-credential-button">
              {editing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
