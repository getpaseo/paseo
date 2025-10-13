interface DeviceSelectorProps {
  devices: Array<{ deviceId: string; label: string }>;
  selectedDeviceId: string;
  onDeviceChange: (deviceId: string) => void;
  disabled?: boolean;
}

export default function DeviceSelector({
  devices,
  selectedDeviceId,
  onDeviceChange,
  disabled,
}: DeviceSelectorProps) {
  if (devices.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 w-full">
      <label htmlFor="audio-device" className="text-xs md:text-sm font-medium text-gray-700">
        Microphone
      </label>
      <select
        id="audio-device"
        value={selectedDeviceId}
        onChange={(e) => onDeviceChange(e.target.value)}
        disabled={disabled}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-gray-900 text-sm md:text-base focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </div>
  );
}
