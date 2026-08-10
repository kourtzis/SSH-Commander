import { createContext, useContext, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogin, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import type { User, LoginRequest, AuthResponse } from "@workspace/api-client-react";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  // Returns the raw auth response: callers must check `totpRequired` —
  // when it's true the password was accepted but the user is NOT yet
  // authenticated (the login page drives the TOTP second step).
  login: (data: LoginRequest) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  isLoggingIn: boolean;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data: user, isLoading } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      retry: false,
      staleTime: Infinity,
    },
  });

  const { mutateAsync: loginMutate, isPending: isLoggingIn } = useLogin();
  const { mutateAsync: logoutMutate } = useLogout();

  const handleLogin = async (data: LoginRequest): Promise<AuthResponse> => {
    const res = await loginMutate({ data });
    // 2FA-pending logins have no session yet — refetching /auth/me now
    // would just 401. The login page invalidates after TOTP verification.
    if (!res?.totpRequired) {
      await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    }
    return res;
  };

  const handleLogout = async () => {
    await logoutMutate();
    queryClient.clear();
  };

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        isLoading,
        login: handleLogin,
        logout: handleLogout,
        isLoggingIn,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
