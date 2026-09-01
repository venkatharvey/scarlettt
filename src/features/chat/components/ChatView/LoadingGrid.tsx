export default function LoadingGrid() {
    // 3x3 grid indices:
    // 0 1 2
    // 3 4 5
    // 6 7 8
    
    // Sequence requested: 3rd dot -> 2nd -> 1st -> 4th -> 5th -> 6th -> 9th -> 8th -> 7th
    // Mapping to 0-based indices: 2 -> 1 -> 0 -> 3 -> 4 -> 5 -> 8 -> 7 -> 6
    const sequence = [2, 1, 0, 3, 4, 5, 8, 7, 6];
    
    return (
        <div className="grid grid-cols-3 gap-0.5 w-fit p-1">
            {[...Array(9)].map((_, i) => {
                // Calculate delay based on position in sequence
                const sequenceIndex = sequence.indexOf(i);
                
                return (
                    <div 
                        key={i}
                        className="w-1 h-1 rounded-full bg-zinc-300 transition-all duration-300"
                        style={{
                            animationName: 'pulse-custom',
                            animationDuration: '1.35s', // 9 steps * 0.15s
                            animationIterationCount: 'infinite',
                            animationDelay: `${sequenceIndex * 0.15}s`,
                            opacity: 0.3 // Default dim state
                        }}
                    />
                );
            })}
            <style>{`
                @keyframes pulse-custom {
                    0% { opacity: 0.3; transform: scale(1); }
                    20% { opacity: 1; transform: scale(1.2); background-color: #18181b; } 
                    40% { opacity: 0.3; transform: scale(1); background-color: #d4d4d8; }
                    100% { opacity: 0.3; transform: scale(1); }
                }
            `}</style>
        </div>
    );
}
