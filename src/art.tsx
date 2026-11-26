/** Original artwork made for this project (no third-party imagery): the logo and six sport plates. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#0b0c10" />
      <path d="M16 4 27 10v12L16 28 5 22V10Z" fill="none" stroke="#d9b45a" strokeWidth="2" />
      <path d="M10 20.5 14 15l3 3 5-7" fill="none" stroke="#3d9bff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22" cy="11" r="1.8" fill="#3d9bff" />
    </svg>
  );
}
const G = "#d9b45a", B = "#3d9bff", L = "#2a2e38";
export function SportArt({ sport, className }: { sport: string; className?: string }) {
  const common = { className, viewBox: "0 0 320 160", role: "img" as const, preserveAspectRatio: "xMidYMid slice" };
  const bg = <><rect width="320" height="160" fill="#0d0f14" /><path d="M0 130 320 70V160H0Z" fill="#11141b" /></>;
  switch (sport) {
    case "mma": return (<svg {...common} aria-label="Octagon cage seen from above"><>{bg}</><polygon points="110,20 210,20 260,70 260,90 210,140 110,140 60,90 60,70" fill="none" stroke={G} strokeWidth="3" /><polygon points="125,40 195,40 235,75 235,85 195,120 125,120 85,85 85,75" fill="none" stroke={L} strokeWidth="2" /><circle cx="140" cy="80" r="9" fill={B} /><circle cx="182" cy="80" r="9" fill={G} /><path d="M149 80h24" stroke="#fff" strokeOpacity=".5" strokeWidth="2" strokeDasharray="4 4" /></svg>);
    case "nhl": return (<svg {...common} aria-label="Ice rink with face-off circles"><>{bg}</><rect x="30" y="25" width="260" height="110" rx="45" fill="none" stroke={G} strokeWidth="3" /><path d="M160 25v110" stroke="#c0392b" strokeWidth="3" /><path d="M110 25v110M210 25v110" stroke={B} strokeWidth="3" /><circle cx="160" cy="80" r="18" fill="none" stroke={B} strokeWidth="2" /><circle cx="75" cy="55" r="12" fill="none" stroke={L} strokeWidth="2" /><circle cx="245" cy="105" r="12" fill="none" stroke={L} strokeWidth="2" /><circle cx="198" cy="72" r="5" fill="#fff" /></svg>);
    case "nfl": return (<svg {...common} aria-label="Gridiron with yard lines and a play route"><>{bg}</><rect x="20" y="25" width="280" height="110" fill="none" stroke={G} strokeWidth="3" />{[60, 95, 130, 165, 200, 235, 270].map((x) => <path key={x} d={`M${x} 25v110`} stroke={L} strokeWidth="2" />)}<path d="M80 110 C130 105 150 50 230 45" fill="none" stroke={B} strokeWidth="3" strokeDasharray="7 6" /><ellipse cx="236" cy="44" rx="9" ry="5.5" fill={G} transform="rotate(-20 236 44)" /></svg>);
    case "nba": return (<svg {...common} aria-label="Basketball half court with a shot arc"><>{bg}</><rect x="40" y="25" width="240" height="110" fill="none" stroke={G} strokeWidth="3" /><path d="M160 25v110" stroke={L} strokeWidth="2" /><circle cx="160" cy="80" r="20" fill="none" stroke={L} strokeWidth="2" /><path d="M40 40h30a40 40 0 0 1 0 80H40" fill="none" stroke={B} strokeWidth="2" /><path d="M110 120 Q150 10 238 70" fill="none" stroke="#fff" strokeOpacity=".5" strokeWidth="2" strokeDasharray="3 5" /><circle cx="240" cy="72" r="8" fill={G} /></svg>);
    case "tennis": return (<svg {...common} aria-label="Tennis court with a ball in flight"><>{bg}</><rect x="40" y="25" width="240" height="110" fill="none" stroke={G} strokeWidth="3" /><path d="M40 40h240M40 120h240M100 40v80M220 40v80M100 80h120" stroke={L} strokeWidth="2" /><path d="M160 22v116" stroke="#fff" strokeOpacity=".7" strokeWidth="3" /><path d="M70 100 Q160 20 250 60" fill="none" stroke={B} strokeWidth="2" strokeDasharray="4 5" /><circle cx="252" cy="60" r="7" fill="#c8e04a" /></svg>);
    default: return (<svg {...common} aria-label="Football pitch with a passing move"><>{bg}</><rect x="20" y="20" width="280" height="120" fill="none" stroke={G} strokeWidth="3" /><path d="M160 20v120" stroke={L} strokeWidth="2" /><circle cx="160" cy="80" r="20" fill="none" stroke={L} strokeWidth="2" /><rect x="20" y="50" width="34" height="60" fill="none" stroke={L} strokeWidth="2" /><rect x="266" y="50" width="34" height="60" fill="none" stroke={L} strokeWidth="2" /><path d="M95 110 L150 70 L215 95 L262 72" fill="none" stroke={B} strokeWidth="3" /><circle cx="95" cy="110" r="4" fill={B} /><circle cx="150" cy="70" r="4" fill={B} /><circle cx="215" cy="95" r="4" fill={B} /><circle cx="264" cy="72" r="7" fill="#fff" /></svg>);
  }
}
