function filenamePart(value: string, fallback: string, limit: number) {
  return (
    value
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._]+|[._]+$/g, "")
      .slice(0, limit)
      .replace(/[._]+$/g, "") || fallback
  );
}

export function artifactName(
  kind: "resume" | "cover",
  company: string,
  role: string,
) {
  return `Samarth_Bhardwaj_${filenamePart(company, "Company", 80)}_${filenamePart(role, "Role", 100)}.${kind === "resume" ? "pdf" : "docx"}`;
}
