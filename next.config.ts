import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // keep PDF/DOCX parsers as plain Node modules on the server
  serverExternalPackages: ["unpdf", "mammoth"],
};

export default nextConfig;
