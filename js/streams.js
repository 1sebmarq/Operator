// streams.js
// Central definition of every stream we capture from the Muse, including the
// metadata required to write a valid XDF StreamHeader. Rates are taken from the
// muse-js / web-muse decoders (EEG 256 Hz, PPG 64 Hz, IMU 52 Hz). If you confirm
// different rates against your hardware, change them here only.

// Muse BLE GATT UUIDs (shared by Muse 2 / Muse S, per muse-js & web-muse).
export const MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb';

export const CHAR = {
  CONTROL: '273e0001-4c4d-454d-96be-f03bac821358',
  TELEMETRY: '273e000b-4c4d-454d-96be-f03bac821358',
  GYRO: '273e0009-4c4d-454d-96be-f03bac821358',
  ACCEL: '273e000a-4c4d-454d-96be-f03bac821358',
  EEG_TP9: '273e0003-4c4d-454d-96be-f03bac821358',
  EEG_AF7: '273e0004-4c4d-454d-96be-f03bac821358',
  EEG_AF8: '273e0005-4c4d-454d-96be-f03bac821358',
  EEG_TP10: '273e0006-4c4d-454d-96be-f03bac821358',
  EEG_AUX: '273e0007-4c4d-454d-96be-f03bac821358',
  PPG1: '273e000f-4c4d-454d-96be-f03bac821358', // ambient
  PPG2: '273e0010-4c4d-454d-96be-f03bac821358', // infrared
  PPG3: '273e0011-4c4d-454d-96be-f03bac821358', // red
};

// Stream identifiers used internally and as XDF stream ids (1-based).
export const STREAM = {
  EEG: 'EEG',
  PPG: 'PPG',
  ACC: 'ACC',
  GYRO: 'GYRO',
  MARKERS: 'MARKERS',
  TELEMETRY: 'TELEMETRY',
};

// Factory so each session gets a fresh, mutable copy (channel labels can change
// when the AUX toggle is on).
export function buildStreamDefs({ includeAux = false, deviceType = 'Muse S', serial = 'unknown', firmware = 'unknown' } = {}) {
  const eegLabels = ['TP9', 'AF7', 'AF8', 'TP10'];
  if (includeAux) eegLabels.push('AUX');

  const common = { manufacturer: 'Interaxon', device_type: deviceType, serial, firmware };

  return {
    [STREAM.EEG]: {
      xdfStreamId: 1,
      key: STREAM.EEG,
      name: 'Muse-EEG',
      type: 'EEG',
      nominal_srate: 256,
      channel_format: 'float32',
      channels: eegLabels.map((l) => ({ label: l, unit: 'microvolts', type: 'EEG' })),
      ...common,
    },
    [STREAM.PPG]: {
      xdfStreamId: 2,
      key: STREAM.PPG,
      name: 'Muse-PPG',
      type: 'PPG',
      nominal_srate: 64,
      channel_format: 'float32',
      channels: [
        { label: 'PPG_Ambient', unit: 'arb', type: 'PPG' },
        { label: 'PPG_IR', unit: 'arb', type: 'PPG' },
        { label: 'PPG_Red', unit: 'arb', type: 'PPG' },
      ],
      ...common,
    },
    [STREAM.ACC]: {
      xdfStreamId: 3,
      key: STREAM.ACC,
      name: 'Muse-Accelerometer',
      type: 'Accelerometer',
      nominal_srate: 52,
      channel_format: 'float32',
      channels: [
        { label: 'ACC_X', unit: 'g', type: 'Accelerometer' },
        { label: 'ACC_Y', unit: 'g', type: 'Accelerometer' },
        { label: 'ACC_Z', unit: 'g', type: 'Accelerometer' },
      ],
      ...common,
    },
    [STREAM.GYRO]: {
      xdfStreamId: 4,
      key: STREAM.GYRO,
      name: 'Muse-Gyroscope',
      type: 'Gyroscope',
      nominal_srate: 52,
      channel_format: 'float32',
      channels: [
        { label: 'GYRO_X', unit: 'deg/s', type: 'Gyroscope' },
        { label: 'GYRO_Y', unit: 'deg/s', type: 'Gyroscope' },
        { label: 'GYRO_Z', unit: 'deg/s', type: 'Gyroscope' },
      ],
      ...common,
    },
    [STREAM.MARKERS]: {
      xdfStreamId: 5,
      key: STREAM.MARKERS,
      name: 'Muse-Markers',
      type: 'Markers',
      nominal_srate: 0, // irregular
      channel_format: 'string',
      channels: [{ label: 'Marker', unit: 'n/a', type: 'Marker' }],
      ...common,
    },
    [STREAM.TELEMETRY]: {
      xdfStreamId: 6,
      key: STREAM.TELEMETRY,
      name: 'Muse-Telemetry',
      type: 'Telemetry',
      nominal_srate: 0, // irregular, on-demand
      channel_format: 'float32',
      channels: [
        { label: 'battery_pct', unit: 'percent', type: 'Battery' },
        { label: 'fuel_gauge_mV', unit: 'millivolts', type: 'Voltage' },
        { label: 'adc_volt', unit: 'arb', type: 'Voltage' },
        { label: 'temperature', unit: 'celsius', type: 'Temperature' },
      ],
      ...common,
    },
  };
}

// Activity labels (non-exclusive). Custom appended at runtime.
export const ACTIVITY_LABELS = ['Scrolling', 'Daydreaming', 'Driving', 'Passenger-princess'];

// Assessment labels (non-exclusive). Custom appended at runtime.
export const ASSESSMENT_LABELS = ['Engaged', 'Distracted', 'Rushed', 'Tired', 'Zombie', 'Fresh'];
