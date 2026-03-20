import { useState } from "react";
import { useListUsers } from "@workspace/api-client-react";
import { useUsersMutations } from "@/hooks/use-mutations";
import { useSelection } from "@/hooks/use-selection";
import { SelectionBar } from "@/components/selection-bar";
import { useAuth } from "@/contexts/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Users as UsersIcon, ShieldAlert, Trash2, Edit2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/utils";

export default function Users() {
  const { user } = useAuth();
  const { data: users = [], isLoading } = useListUsers({ query: { enabled: user?.role === 'admin' } });
  const { createUser, updateUser, deleteUser } = useUsersMutations();
  const { toast } = useToast();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "operator">("operator");

  const selectableUsers = users.filter(u => u.id !== user?.id);
  const selection = useSelection(selectableUsers.map(u => u.id));

  if (user?.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <ShieldAlert className="w-16 h-16 text-destructive mb-4" />
        <h2 className="text-2xl font-bold">Access Denied</h2>
        <p className="text-muted-foreground mt-2">You must be an administrator to view this page.</p>
      </div>
    );
  }

  const handleOpenDialog = (u?: any) => {
    if (u) {
      setEditingUser(u);
      setUsername(u.username);
      setEmail(u.email || "");
      setPassword("");
      setRole(u.role);
    } else {
      setEditingUser(null);
      setUsername("");
      setEmail("");
      setPassword("");
      setRole("operator");
    }
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      if (editingUser) {
        const data: any = { username, role };
        if (email) data.email = email;
        if (password) data.password = password;
        await updateUser.mutateAsync({ id: editingUser.id, data });
        toast({ title: "User updated" });
      } else {
        if (!password) {
          toast({ title: "Password required for new users", variant: "destructive" });
          return;
        }
        await createUser.mutateAsync({ data: { username, email, password, role } });
        toast({ title: "User created" });
      }
      setIsDialogOpen(false);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: number) => {
    if (id === user.id) {
      toast({ title: "Cannot delete yourself", variant: "destructive" });
      return;
    }
    if (confirm("Delete this user?")) {
      try {
        await deleteUser.mutateAsync({ id });
        toast({ title: "User deleted" });
      } catch (err: any) {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selection.count} selected user(s)?`)) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(selection.ids.map(id => deleteUser.mutateAsync({ id })));
      toast({ title: `${selection.count} user(s) deleted` });
      selection.clear();
    } catch (err: any) {
      toast({ title: "Error deleting users", description: err.message, variant: "destructive" });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Users</h1>
          <p className="text-muted-foreground mt-1">Manage administrators and operators.</p>
        </div>
        <Button onClick={() => handleOpenDialog()} className="gap-2">
          <Plus className="w-4 h-4" /> Add User
        </Button>
      </div>

      <SelectionBar count={selection.count} label="users" onDelete={handleBulkDelete} onClear={selection.clear} isDeleting={isBulkDeleting} />

      <Card className="glass-panel overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading users...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-black/40 text-muted-foreground text-xs uppercase border-b border-border/50">
                  <tr>
                    <th className="px-4 py-4 w-10">
                      <Checkbox
                        checked={selection.isAllSelected}
                        onCheckedChange={selection.toggleAll}
                        aria-label="Select all"
                        {...(selection.isSomeSelected ? { "data-state": "indeterminate" as any } : {})}
                      />
                    </th>
                    <th className="px-6 py-4 font-medium">User</th>
                    <th className="px-6 py-4 font-medium">Role</th>
                    <th className="px-6 py-4 font-medium">Joined</th>
                    <th className="px-6 py-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {users.map(u => (
                    <tr key={u.id} className={`hover:bg-white/5 transition-colors ${selection.selected.has(u.id) ? "bg-primary/5" : ""}`}>
                      <td className="px-4 py-4">
                        {u.id !== user.id ? (
                          <Checkbox
                            checked={selection.selected.has(u.id)}
                            onCheckedChange={() => selection.toggle(u.id)}
                            aria-label={`Select ${u.username}`}
                          />
                        ) : <div className="w-4" />}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary/50 to-accent flex items-center justify-center text-sm font-bold text-white">
                            {u.username.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{u.username}</p>
                            {u.email && <p className="text-xs text-muted-foreground">{u.email}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="capitalize">
                          {u.role}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">
                        {formatDate(u.createdAt).split(' ')[0]}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(u)}>
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(u.id)} disabled={u.id === user.id}>
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

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingUser ? "Edit User" : "New User"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input value={username} onChange={e => setUsername(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Email (Optional)</Label>
              <Input value={email} onChange={e => setEmail(e.target.value)} type="email" />
            </div>
            <div className="space-y-2">
              <Label>Password {editingUser && <span className="text-muted-foreground text-xs">(Leave blank to keep unchanged)</span>}</Label>
              <Input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="••••••••" />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <select 
                className="flex h-10 w-full rounded-xl border border-input bg-background/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                value={role} 
                onChange={(e: any) => setRole(e.target.value)}
              >
                <option value="operator">Operator (Run jobs only)</option>
                <option value="admin">Administrator (Full access)</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!username || (!editingUser && !password)}>Save User</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
