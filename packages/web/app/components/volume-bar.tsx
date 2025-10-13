interface VolumeBarProps {
  volume: number;
  isMuted?: boolean;
}

export default function VolumeBar({ volume, isMuted }: VolumeBarProps) {
  function getColor() {
    if (isMuted) return 'bg-gray-300';
    if (volume > 80) return 'bg-red-500';
    if (volume > 60) return 'bg-yellow-400';
    return 'bg-green-500';
  }

  return (
    <div className="w-10 h-48 bg-gray-200 rounded-lg overflow-hidden flex flex-col-reverse">
      <div
        className={`${getColor()} transition-all duration-100 ease-out`}
        style={{ height: `${isMuted ? 0 : volume}%` }}
      />
    </div>
  );
}
