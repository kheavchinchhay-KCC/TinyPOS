import { useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { setErrorReportingContext } from "../lib/errorReporting";

export default function ErrorReportingBridge() {
  const { supabase, profile } = useAuth();

  useEffect(() => {
    setErrorReportingContext({
      supabase,
      profile
    });
  }, [supabase, profile]);

  return null;
}
