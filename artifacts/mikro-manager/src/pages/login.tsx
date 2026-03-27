import { useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { useLocation } from "wouter";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TerminalSquare, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { login, isLoggingIn } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login({ username, password });
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
          <CardHeader className="text-center pb-8 pt-8">
            <div className="mx-auto bg-primary/20 w-16 h-16 rounded-2xl flex items-center justify-center text-primary mb-6 shadow-[0_0_30px_rgba(45,212,191,0.2)] border border-primary/30">
              <TerminalSquare className="w-8 h-8" />
            </div>
            <CardTitle className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
              SSH Commander
            </CardTitle>
            <CardDescription className="text-base mt-2">
              Sign in to manage your network scripts
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
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
