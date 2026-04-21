import { Suspense } from "react";

import { LoginForm } from "@/app/login/LoginForm";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-50" />}>
      <LoginForm />
    </Suspense>
  );
}
