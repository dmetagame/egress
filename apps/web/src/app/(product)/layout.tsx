import { AppShell } from "@/components/app-shell";
import { getProductSnapshot } from "@/lib/server/snapshot";

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const snapshot = await getProductSnapshot();
  return <AppShell snapshot={snapshot}>{children}</AppShell>;
}
