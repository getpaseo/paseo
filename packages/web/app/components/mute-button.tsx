interface MuteButtonProps {
  isMuted: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export default function MuteButton({ isMuted, onToggle, disabled }: MuteButtonProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`
        w-full px-6 md:px-8 py-3 md:py-4 rounded-lg font-medium transition-colors
        ${isMuted
          ? 'bg-red-500 hover:bg-red-600 text-white'
          : 'bg-blue-500 hover:bg-blue-600 text-white'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      {isMuted ? 'Unmute' : 'Mute'}
    </button>
  );
}
