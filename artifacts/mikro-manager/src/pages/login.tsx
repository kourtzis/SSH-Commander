import { useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useVerifyTotp, getGetMeQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, ArrowLeft } from "lucide-react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { APP_VERSION } from "@/lib/version";
import { ChangelogDialog } from "@/components/changelog-dialog";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [code, setCode] = useState("");
  const { login, isLoggingIn } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { mutateAsync: verifyTotp, isPending: isVerifying } = useVerifyTotp();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await login({ username, password });
      if (res?.totpRequired) {
        setCode("");
        setStep("totp");
        return;
      }
      toast({ title: "Welcome back", description: "Successfully logged in." });
      setLocation("/");
    } catch (err: any) {
      toast({
        title: "Login failed",
        description: err.message || "Invalid credentials",
        variant: "destructive"
      });
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await verifyTotp({ data: { code: code.trim() } });
      await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      toast({ title: "Welcome back", description: "Successfully logged in." });
      setLocation("/");
    } catch (err: any) {
      toast({
        title: "Verification failed",
        description: err.message || "Invalid code — try again or use a recovery code",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-background">
      {/* Background Image & Overlay */}
      <div className="absolute inset-0 z-0">
        <img 
          src={`${import.meta.env.BASE_URL}images/auth-bg.png`} 
          alt="Abstract tech background" 
          className="w-full h-full object-cover opacity-30"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent" />
      </div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="z-10 w-full max-w-md px-4"
      >
        <Card className="glass-panel border-white/10 p-2 rounded-3xl shadow-2xl shadow-primary/10">
          {step === "credentials" ? (
            <>
              <CardHeader className="text-center pb-8 pt-8">
                <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(45,212,191,0.2)] border border-primary/30 bg-primary/10 overflow-hidden">
                  <img src={`${import.meta.env.BASE_URL}logo.png`} alt="SSH Commander" className="w-12 h-12 object-contain" />
                </div>
                <CardTitle className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
                  SSH Commander
                </CardTitle>
                <CardDescription className="text-base mt-2">
                  Sign in to manage your SSH devices
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Input 
                        type="text" 
                        placeholder="Username" 
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                        className="h-12 bg-black/40 border-white/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Input 
                        type="password" 
                        placeholder="Password" 
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        className="h-12 bg-black/40 border-white/10"
                      />
                    </div>
                  </div>
                  <Button type="submit" className="w-full h-12 text-base" disabled={isLoggingIn}>
                    {isLoggingIn ? <Loader2 className="w-5 h-5 animate-spin" /> : "Sign In"}
                  </Button>
                  <div className="flex justify-center mt-4">
                    <ChangelogDialog>
                      <button className="text-xs text-muted-foreground/60 hover:text-primary transition-colors cursor-pointer">
                        v{APP_VERSION}
                      </button>
                    </ChangelogDialog>
                  </div>
                </form>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="text-center pb-8 pt-8">
                <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(45,212,191,0.2)] border border-primary/30 bg-primary/10">
                  <ShieldCheck className="w-9 h-9 text-primary" />
                </div>
                <CardTitle className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
                  Two-Factor Authentication
                </CardTitle>
                <CardDescription className="text-base mt-2">
                  Enter the 6-digit code from your authenticator app
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleVerify} className="space-y-6">
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456 or recovery code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoFocus
                    className="h-12 bg-black/40 border-white/10 text-center text-lg tracking-widest"
                  />
                  <Button type="submit" className="w-full h-12 text-base" disabled={isVerifying || code.trim().length < 6}>
                    {isVerifying ? <Loader2 className="w-5 h-5 animate-spin" /> : "Verify"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => { setStep("credentials"); setCode(""); }}
                    className="w-full flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
                  >
                    <ArrowLeft className="w-4 h-4" /> Back to sign in
                  </button>
                  <p className="text-xs text-muted-foreground/60 text-center">
                    Lost your device? Enter one of your recovery codes (xxxxx-xxxxx) instead.
                  </p>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </motion.div>
    </div>
  );
}
