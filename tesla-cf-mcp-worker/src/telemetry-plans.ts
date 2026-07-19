/**
 * Telemetry field plans for the budget ladder (see manageTelemetryLadder in
 * rules.ts). Three steps, most→least fidelity:
 *
 *   permanent — the steady-state plan: the lean field set plus a 5s
 *               driving-dynamics tier (speed/IMU/GPS). ~$1-2/mo in signals,
 *               leaving real headroom for REST reconciliation. The full
 *               228-field/1s plan proved structurally unsustainable inside
 *               the $10 credit (~$9.4/mo signals alone, July 2026).
 *   lean      — the July 2026 budget-saver trim: no per-corner Di*
 *               diagnostics, dynamics at 10-15s. ~$0.1-0.2/day.
 *   minimal   — survival mode near budget exhaustion: location, drive/charge
 *               state, SoC, pack V/I (keeps derived power alive), TPMS,
 *               temps. ~$0.02/day.
 *
 * Generated from the live vehicle config snapshots in
 * fleet-telemetry-bridge/telemetry-plan-*.json -- keep hostname/CA in sync
 * with the bridge (RUNBOOK.md).
 */

export type TelemetryPlanStep = "permanent" | "lean" | "minimal";

export const TELEMETRY_HOSTNAME = "telemetry.rightcraft.io";
export const TELEMETRY_PORT = 443;
export const TELEMETRY_CA = "-----BEGIN CERTIFICATE-----\nMIIDFDCCAfygAwIBAgIUQ4zp4KLSjEVQhiBYE32m7vRVi4gwDQYJKoZIhvcNAQEL\nBQAwIjEgMB4GA1UEAwwXVGVzbGEgVGVsZW1ldHJ5IFNlbGYgQ0EwHhcNMjYwNzA1\nMjEwNDExWhcNMzYwNzAyMjEwNDExWjAiMSAwHgYDVQQDDBdUZXNsYSBUZWxlbWV0\ncnkgU2VsZiBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANhD8iXI\nplHCbWTojZ6o0gdtTZ+hkU00Zlny4HxnhRvASe5QZdAqG6jJZCqyBV61IIgDwguG\nMDOZVjqLDy3CtY65vtEBgJrvIkYQWW/xpJDW/ErMK7YrYak4Bp947sNHhyhq3S/O\nansPReC4/32wC3KBQ+rmqkwPMS4loRabuY80HvjzY8oUF85sc0pcz+Fe0h9ssRuh\nasv8dfETCPkOqw7ynKs9vskM6pankvksBAN4zRL/C0Q4Wzf2fsalCnZ+vVinBT+F\n9b2tG93hQWVECPPbPrCWJagYcA+tW5xkTikUj9QtyEmHdQRErMoEPxm9vsKfXghc\nlguPPEne85FamekCAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8E\nBAMCAQYwHQYDVR0OBBYEFOVoDoppRH64xgkrB9t1Sb80GL0ZMA0GCSqGSIb3DQEB\nCwUAA4IBAQC4xmCRh6KmeWAQeTUe7zeTjdrQtMRuFHhHKpT9x7x1C9xWrBl7SX2L\npCk1Mv1b2KXTG4WFwYFAm8nZhfdkimojofJGy0Sam/7CI1I5HrJvmZylW9kPvKSI\n9d4mAz5GdtF99U/Aof/8AO8/UmeVp48lwHpLCA5Zsepf4vvaz9cV/k+QN/VA3V+u\nCSdphUjzwZr6tdKkuSoAPyDUgkq/fs6SUc4h8J/QEpDlgnnNz7NUEx/ludqywGCe\nZhtlh6mIQiniSdvPmHNg7QFQ9J6a4/OIwDS98tu00w9QbvirpFweRD5EFPIXSx+2\nGLEO0ZIVuJyHhMnHeeBABj4QlAMV1YI6\n-----END CERTIFICATE-----";

type FieldPlan = Record<string, { interval_seconds: number; minimum_delta?: number }>;

const PERMANENT_FIELDS: FieldPlan = {
  "ACChargingEnergyIn": {
    "interval_seconds": 60
  },
  "ACChargingPower": {
    "interval_seconds": 60
  },
  "AutoSeatClimateLeft": {
    "interval_seconds": 120
  },
  "AutoSeatClimateRight": {
    "interval_seconds": 120
  },
  "AutomaticBlindSpotCamera": {
    "interval_seconds": 60
  },
  "AutomaticEmergencyBrakingOff": {
    "interval_seconds": 60
  },
  "BMSState": {
    "interval_seconds": 60
  },
  "BatteryHeaterOn": {
    "interval_seconds": 60
  },
  "BatteryLevel": {
    "interval_seconds": 60
  },
  "BlindSpotCollisionWarningChime": {
    "interval_seconds": 60
  },
  "BmsFullchargecomplete": {
    "interval_seconds": 60
  },
  "BrakePedal": {
    "interval_seconds": 60
  },
  "BrakePedalPos": {
    "interval_seconds": 15
  },
  "BrickVoltageMax": {
    "interval_seconds": 60
  },
  "BrickVoltageMin": {
    "interval_seconds": 60
  },
  "CabinOverheatProtectionMode": {
    "interval_seconds": 120
  },
  "CabinOverheatProtectionTemperatureLimit": {
    "interval_seconds": 120
  },
  "CarType": {
    "interval_seconds": 3600
  },
  "CenterDisplay": {
    "interval_seconds": 120
  },
  "ChargeAmps": {
    "interval_seconds": 60
  },
  "ChargeCurrentRequest": {
    "interval_seconds": 60
  },
  "ChargeCurrentRequestMax": {
    "interval_seconds": 60
  },
  "ChargeEnableRequest": {
    "interval_seconds": 60
  },
  "ChargeLimitSoc": {
    "interval_seconds": 300
  },
  "ChargePort": {
    "interval_seconds": 3600
  },
  "ChargePortColdWeatherMode": {
    "interval_seconds": 120
  },
  "ChargePortDoorOpen": {
    "interval_seconds": 120
  },
  "ChargePortLatch": {
    "interval_seconds": 120
  },
  "ChargeRateMilePerHour": {
    "interval_seconds": 60
  },
  "ChargeState": {
    "interval_seconds": 60
  },
  "ChargerPhases": {
    "interval_seconds": 60
  },
  "ChargerVoltage": {
    "interval_seconds": 60
  },
  "ChargingCableType": {
    "interval_seconds": 60
  },
  "ClimateKeeperMode": {
    "interval_seconds": 300
  },
  "ClimateSeatCoolingFrontLeft": {
    "interval_seconds": 120
  },
  "ClimateSeatCoolingFrontRight": {
    "interval_seconds": 120
  },
  "CruiseFollowDistance": {
    "interval_seconds": 60
  },
  "CruiseSetSpeed": {
    "interval_seconds": 60
  },
  "CurrentLimitMph": {
    "interval_seconds": 60
  },
  "DCChargingEnergyIn": {
    "interval_seconds": 60
  },
  "DCChargingPower": {
    "interval_seconds": 60
  },
  "DefrostForPreconditioning": {
    "interval_seconds": 120
  },
  "DefrostMode": {
    "interval_seconds": 120
  },
  "DestinationLocation": {
    "interval_seconds": 60
  },
  "DestinationName": {
    "interval_seconds": 60
  },
  "DetailedChargeState": {
    "interval_seconds": 60
  },
  "DoorState": {
    "interval_seconds": 120
  },
  "DriveRail": {
    "interval_seconds": 60
  },
  "DriverSeatBelt": {
    "interval_seconds": 60
  },
  "DriverSeatOccupied": {
    "interval_seconds": 60
  },
  "EfficiencyPackage": {
    "interval_seconds": 3600
  },
  "EmergencyLaneDepartureAvoidance": {
    "interval_seconds": 60
  },
  "EnergyRemaining": {
    "interval_seconds": 120
  },
  "EstBatteryRange": {
    "interval_seconds": 120
  },
  "EstimatedHoursToChargeTermination": {
    "interval_seconds": 60
  },
  "EuropeVehicle": {
    "interval_seconds": 3600
  },
  "ExpectedEnergyPercentAtTripArrival": {
    "interval_seconds": 300
  },
  "ExteriorColor": {
    "interval_seconds": 3600
  },
  "FastChargerPresent": {
    "interval_seconds": 60
  },
  "FastChargerType": {
    "interval_seconds": 60
  },
  "FdWindow": {
    "interval_seconds": 120
  },
  "ForwardCollisionWarning": {
    "interval_seconds": 60
  },
  "FpWindow": {
    "interval_seconds": 120
  },
  "Gear": {
    "interval_seconds": 60
  },
  "GpsHeading": {
    "interval_seconds": 60
  },
  "GpsState": {
    "interval_seconds": 60
  },
  "GuestModeEnabled": {
    "interval_seconds": 120
  },
  "GuestModeMobileAccessState": {
    "interval_seconds": 120
  },
  "HomelinkDeviceCount": {
    "interval_seconds": 120
  },
  "HomelinkNearby": {
    "interval_seconds": 120
  },
  "HvacACEnabled": {
    "interval_seconds": 120
  },
  "HvacAutoMode": {
    "interval_seconds": 120
  },
  "HvacFanSpeed": {
    "interval_seconds": 120
  },
  "HvacFanStatus": {
    "interval_seconds": 120
  },
  "HvacLeftTemperatureRequest": {
    "interval_seconds": 120
  },
  "HvacPower": {
    "interval_seconds": 120
  },
  "HvacRightTemperatureRequest": {
    "interval_seconds": 120
  },
  "HvacSteeringWheelHeatAuto": {
    "interval_seconds": 120
  },
  "HvacSteeringWheelHeatLevel": {
    "interval_seconds": 120
  },
  "Hvil": {
    "interval_seconds": 120
  },
  "IdealBatteryRange": {
    "interval_seconds": 60
  },
  "InsideTemp": {
    "interval_seconds": 300
  },
  "IsolationResistance": {
    "interval_seconds": 120
  },
  "LaneDepartureAvoidance": {
    "interval_seconds": 60
  },
  "LateralAcceleration": {
    "interval_seconds": 5
  },
  "LifetimeEnergyUsed": {
    "interval_seconds": 300
  },
  "LightsHazardsActive": {
    "interval_seconds": 60
  },
  "LightsHighBeams": {
    "interval_seconds": 60
  },
  "LightsTurnSignal": {
    "interval_seconds": 60
  },
  "LocatedAtFavorite": {
    "interval_seconds": 60
  },
  "LocatedAtHome": {
    "interval_seconds": 60
  },
  "LocatedAtWork": {
    "interval_seconds": 60
  },
  "Location": {
    "interval_seconds": 10
  },
  "Locked": {
    "interval_seconds": 300
  },
  "LongitudinalAcceleration": {
    "interval_seconds": 5
  },
  "MediaAudioVolume": {
    "interval_seconds": 60
  },
  "MediaAudioVolumeIncrement": {
    "interval_seconds": 300
  },
  "MediaAudioVolumeMax": {
    "interval_seconds": 300
  },
  "MediaNowPlayingAlbum": {
    "interval_seconds": 60
  },
  "MediaNowPlayingArtist": {
    "interval_seconds": 60
  },
  "MediaNowPlayingDuration": {
    "interval_seconds": 60
  },
  "MediaNowPlayingElapsed": {
    "interval_seconds": 60
  },
  "MediaNowPlayingStation": {
    "interval_seconds": 60
  },
  "MediaNowPlayingTitle": {
    "interval_seconds": 60
  },
  "MediaPlaybackSource": {
    "interval_seconds": 60
  },
  "MediaPlaybackStatus": {
    "interval_seconds": 60
  },
  "MilesSinceReset": {
    "interval_seconds": 300
  },
  "MilesToArrival": {
    "interval_seconds": 60
  },
  "MinutesToArrival": {
    "interval_seconds": 60
  },
  "ModuleTempMax": {
    "interval_seconds": 60
  },
  "ModuleTempMin": {
    "interval_seconds": 60
  },
  "NotEnoughPowerToHeat": {
    "interval_seconds": 60
  },
  "NumBrickVoltageMax": {
    "interval_seconds": 60
  },
  "NumBrickVoltageMin": {
    "interval_seconds": 60
  },
  "NumModuleTempMax": {
    "interval_seconds": 60
  },
  "NumModuleTempMin": {
    "interval_seconds": 60
  },
  "Odometer": {
    "interval_seconds": 60
  },
  "OriginLocation": {
    "interval_seconds": 60
  },
  "OutsideTemp": {
    "interval_seconds": 300
  },
  "PackCurrent": {
    "interval_seconds": 60
  },
  "PackVoltage": {
    "interval_seconds": 60
  },
  "PairedPhoneKeyAndKeyFobQty": {
    "interval_seconds": 120
  },
  "PassengerSeatBelt": {
    "interval_seconds": 60
  },
  "PedalPosition": {
    "interval_seconds": 60
  },
  "PinToDriveEnabled": {
    "interval_seconds": 120
  },
  "PreconditioningEnabled": {
    "interval_seconds": 60
  },
  "RatedRange": {
    "interval_seconds": 120
  },
  "RdWindow": {
    "interval_seconds": 120
  },
  "RearDefrostEnabled": {
    "interval_seconds": 120
  },
  "RearDisplayHvacEnabled": {
    "interval_seconds": 120
  },
  "RearSeatHeaters": {
    "interval_seconds": 3600
  },
  "RemoteStartEnabled": {
    "interval_seconds": 120
  },
  "RightHandDrive": {
    "interval_seconds": 3600
  },
  "RoofColor": {
    "interval_seconds": 3600
  },
  "RouteLine": {
    "interval_seconds": 300
  },
  "RouteTrafficMinutesDelay": {
    "interval_seconds": 60
  },
  "RpWindow": {
    "interval_seconds": 120
  },
  "ScheduledChargingMode": {
    "interval_seconds": 60
  },
  "ScheduledChargingPending": {
    "interval_seconds": 60
  },
  "ScheduledChargingStartTime": {
    "interval_seconds": 60
  },
  "SeatHeaterLeft": {
    "interval_seconds": 120
  },
  "SeatHeaterRearCenter": {
    "interval_seconds": 120
  },
  "SeatHeaterRearLeft": {
    "interval_seconds": 120
  },
  "SeatHeaterRearRight": {
    "interval_seconds": 120
  },
  "SeatHeaterRight": {
    "interval_seconds": 120
  },
  "SeatVentEnabled": {
    "interval_seconds": 120
  },
  "SelfDrivingMilesSinceReset": {
    "interval_seconds": 300,
    "minimum_delta": 1
  },
  "SentryMode": {
    "interval_seconds": 300
  },
  "ServiceMode": {
    "interval_seconds": 120
  },
  "Setting24HourTime": {
    "interval_seconds": 3600
  },
  "SettingChargeUnit": {
    "interval_seconds": 3600
  },
  "SettingDistanceUnit": {
    "interval_seconds": 3600
  },
  "SettingTemperatureUnit": {
    "interval_seconds": 3600
  },
  "SettingTirePressureUnit": {
    "interval_seconds": 3600
  },
  "Soc": {
    "interval_seconds": 60
  },
  "SoftwareUpdateDownloadPercentComplete": {
    "interval_seconds": 300
  },
  "SoftwareUpdateExpectedDurationMinutes": {
    "interval_seconds": 300
  },
  "SoftwareUpdateInstallationPercentComplete": {
    "interval_seconds": 300
  },
  "SoftwareUpdateScheduledStartTime": {
    "interval_seconds": 300
  },
  "SoftwareUpdateVersion": {
    "interval_seconds": 300
  },
  "SpeedLimitMode": {
    "interval_seconds": 120
  },
  "SpeedLimitWarning": {
    "interval_seconds": 60
  },
  "SunroofInstalled": {
    "interval_seconds": 3600
  },
  "SuperchargerSessionTripPlanner": {
    "interval_seconds": 60
  },
  "TimeToFullCharge": {
    "interval_seconds": 60
  },
  "TpmsHardWarnings": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeFl": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeFr": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeRl": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeRr": {
    "interval_seconds": 300
  },
  "TpmsPressureFl": {
    "interval_seconds": 300
  },
  "TpmsPressureFr": {
    "interval_seconds": 300
  },
  "TpmsPressureRl": {
    "interval_seconds": 300
  },
  "TpmsPressureRr": {
    "interval_seconds": 300
  },
  "TpmsSoftWarnings": {
    "interval_seconds": 300
  },
  "Trim": {
    "interval_seconds": 3600
  },
  "ValetModeEnabled": {
    "interval_seconds": 120
  },
  "VehicleName": {
    "interval_seconds": 3600
  },
  "VehicleSpeed": {
    "interval_seconds": 5
  },
  "Version": {
    "interval_seconds": 3600
  },
  "WheelType": {
    "interval_seconds": 3600
  },
  "WiperHeatEnabled": {
    "interval_seconds": 120
  }
};

const LEAN_FIELDS: FieldPlan = {
  "ACChargingEnergyIn": {
    "interval_seconds": 60
  },
  "ACChargingPower": {
    "interval_seconds": 60
  },
  "AutoSeatClimateLeft": {
    "interval_seconds": 120
  },
  "AutoSeatClimateRight": {
    "interval_seconds": 120
  },
  "AutomaticBlindSpotCamera": {
    "interval_seconds": 60
  },
  "AutomaticEmergencyBrakingOff": {
    "interval_seconds": 60
  },
  "BMSState": {
    "interval_seconds": 60
  },
  "BatteryHeaterOn": {
    "interval_seconds": 60
  },
  "BatteryLevel": {
    "interval_seconds": 60
  },
  "BlindSpotCollisionWarningChime": {
    "interval_seconds": 60
  },
  "BmsFullchargecomplete": {
    "interval_seconds": 60
  },
  "BrakePedal": {
    "interval_seconds": 60
  },
  "BrakePedalPos": {
    "interval_seconds": 60
  },
  "BrickVoltageMax": {
    "interval_seconds": 60
  },
  "BrickVoltageMin": {
    "interval_seconds": 60
  },
  "CabinOverheatProtectionMode": {
    "interval_seconds": 120
  },
  "CabinOverheatProtectionTemperatureLimit": {
    "interval_seconds": 120
  },
  "CarType": {
    "interval_seconds": 3600
  },
  "CenterDisplay": {
    "interval_seconds": 120
  },
  "ChargeAmps": {
    "interval_seconds": 60
  },
  "ChargeCurrentRequest": {
    "interval_seconds": 60
  },
  "ChargeCurrentRequestMax": {
    "interval_seconds": 60
  },
  "ChargeEnableRequest": {
    "interval_seconds": 60
  },
  "ChargeLimitSoc": {
    "interval_seconds": 300
  },
  "ChargePort": {
    "interval_seconds": 3600
  },
  "ChargePortColdWeatherMode": {
    "interval_seconds": 120
  },
  "ChargePortDoorOpen": {
    "interval_seconds": 120
  },
  "ChargePortLatch": {
    "interval_seconds": 120
  },
  "ChargeRateMilePerHour": {
    "interval_seconds": 60
  },
  "ChargeState": {
    "interval_seconds": 60
  },
  "ChargerPhases": {
    "interval_seconds": 60
  },
  "ChargerVoltage": {
    "interval_seconds": 60
  },
  "ChargingCableType": {
    "interval_seconds": 60
  },
  "ClimateKeeperMode": {
    "interval_seconds": 300
  },
  "ClimateSeatCoolingFrontLeft": {
    "interval_seconds": 120
  },
  "ClimateSeatCoolingFrontRight": {
    "interval_seconds": 120
  },
  "CruiseFollowDistance": {
    "interval_seconds": 60
  },
  "CruiseSetSpeed": {
    "interval_seconds": 60
  },
  "CurrentLimitMph": {
    "interval_seconds": 60
  },
  "DCChargingEnergyIn": {
    "interval_seconds": 60
  },
  "DCChargingPower": {
    "interval_seconds": 60
  },
  "DefrostForPreconditioning": {
    "interval_seconds": 120
  },
  "DefrostMode": {
    "interval_seconds": 120
  },
  "DestinationLocation": {
    "interval_seconds": 60
  },
  "DestinationName": {
    "interval_seconds": 60
  },
  "DetailedChargeState": {
    "interval_seconds": 60
  },
  "DoorState": {
    "interval_seconds": 120
  },
  "DriveRail": {
    "interval_seconds": 60
  },
  "DriverSeatBelt": {
    "interval_seconds": 60
  },
  "DriverSeatOccupied": {
    "interval_seconds": 60
  },
  "EfficiencyPackage": {
    "interval_seconds": 3600
  },
  "EmergencyLaneDepartureAvoidance": {
    "interval_seconds": 60
  },
  "EnergyRemaining": {
    "interval_seconds": 120
  },
  "EstBatteryRange": {
    "interval_seconds": 120
  },
  "EstimatedHoursToChargeTermination": {
    "interval_seconds": 60
  },
  "EuropeVehicle": {
    "interval_seconds": 3600
  },
  "ExpectedEnergyPercentAtTripArrival": {
    "interval_seconds": 300
  },
  "ExteriorColor": {
    "interval_seconds": 3600
  },
  "FastChargerPresent": {
    "interval_seconds": 60
  },
  "FastChargerType": {
    "interval_seconds": 60
  },
  "FdWindow": {
    "interval_seconds": 120
  },
  "ForwardCollisionWarning": {
    "interval_seconds": 60
  },
  "FpWindow": {
    "interval_seconds": 120
  },
  "Gear": {
    "interval_seconds": 60
  },
  "GpsHeading": {
    "interval_seconds": 60
  },
  "GpsState": {
    "interval_seconds": 60
  },
  "GuestModeEnabled": {
    "interval_seconds": 120
  },
  "GuestModeMobileAccessState": {
    "interval_seconds": 120
  },
  "HomelinkDeviceCount": {
    "interval_seconds": 120
  },
  "HomelinkNearby": {
    "interval_seconds": 120
  },
  "HvacACEnabled": {
    "interval_seconds": 120
  },
  "HvacAutoMode": {
    "interval_seconds": 120
  },
  "HvacFanSpeed": {
    "interval_seconds": 120
  },
  "HvacFanStatus": {
    "interval_seconds": 120
  },
  "HvacLeftTemperatureRequest": {
    "interval_seconds": 120
  },
  "HvacPower": {
    "interval_seconds": 120
  },
  "HvacRightTemperatureRequest": {
    "interval_seconds": 120
  },
  "HvacSteeringWheelHeatAuto": {
    "interval_seconds": 120
  },
  "HvacSteeringWheelHeatLevel": {
    "interval_seconds": 120
  },
  "Hvil": {
    "interval_seconds": 120
  },
  "IdealBatteryRange": {
    "interval_seconds": 60
  },
  "InsideTemp": {
    "interval_seconds": 300
  },
  "IsolationResistance": {
    "interval_seconds": 120
  },
  "LaneDepartureAvoidance": {
    "interval_seconds": 60
  },
  "LateralAcceleration": {
    "interval_seconds": 15
  },
  "LifetimeEnergyUsed": {
    "interval_seconds": 300
  },
  "LightsHazardsActive": {
    "interval_seconds": 60
  },
  "LightsHighBeams": {
    "interval_seconds": 60
  },
  "LightsTurnSignal": {
    "interval_seconds": 60
  },
  "LocatedAtFavorite": {
    "interval_seconds": 60
  },
  "LocatedAtHome": {
    "interval_seconds": 60
  },
  "LocatedAtWork": {
    "interval_seconds": 60
  },
  "Location": {
    "interval_seconds": 15
  },
  "Locked": {
    "interval_seconds": 300
  },
  "LongitudinalAcceleration": {
    "interval_seconds": 15
  },
  "MediaAudioVolume": {
    "interval_seconds": 60
  },
  "MediaAudioVolumeIncrement": {
    "interval_seconds": 300
  },
  "MediaAudioVolumeMax": {
    "interval_seconds": 300
  },
  "MediaNowPlayingAlbum": {
    "interval_seconds": 60
  },
  "MediaNowPlayingArtist": {
    "interval_seconds": 60
  },
  "MediaNowPlayingDuration": {
    "interval_seconds": 60
  },
  "MediaNowPlayingElapsed": {
    "interval_seconds": 60
  },
  "MediaNowPlayingStation": {
    "interval_seconds": 60
  },
  "MediaNowPlayingTitle": {
    "interval_seconds": 60
  },
  "MediaPlaybackSource": {
    "interval_seconds": 60
  },
  "MediaPlaybackStatus": {
    "interval_seconds": 60
  },
  "MilesSinceReset": {
    "interval_seconds": 300
  },
  "MilesToArrival": {
    "interval_seconds": 60
  },
  "MinutesToArrival": {
    "interval_seconds": 60
  },
  "ModuleTempMax": {
    "interval_seconds": 60
  },
  "ModuleTempMin": {
    "interval_seconds": 60
  },
  "NotEnoughPowerToHeat": {
    "interval_seconds": 60
  },
  "NumBrickVoltageMax": {
    "interval_seconds": 60
  },
  "NumBrickVoltageMin": {
    "interval_seconds": 60
  },
  "NumModuleTempMax": {
    "interval_seconds": 60
  },
  "NumModuleTempMin": {
    "interval_seconds": 60
  },
  "Odometer": {
    "interval_seconds": 60
  },
  "OriginLocation": {
    "interval_seconds": 60
  },
  "OutsideTemp": {
    "interval_seconds": 300
  },
  "PackCurrent": {
    "interval_seconds": 60
  },
  "PackVoltage": {
    "interval_seconds": 60
  },
  "PairedPhoneKeyAndKeyFobQty": {
    "interval_seconds": 120
  },
  "PassengerSeatBelt": {
    "interval_seconds": 60
  },
  "PedalPosition": {
    "interval_seconds": 60
  },
  "PinToDriveEnabled": {
    "interval_seconds": 120
  },
  "PreconditioningEnabled": {
    "interval_seconds": 60
  },
  "RatedRange": {
    "interval_seconds": 120
  },
  "RdWindow": {
    "interval_seconds": 120
  },
  "RearDefrostEnabled": {
    "interval_seconds": 120
  },
  "RearDisplayHvacEnabled": {
    "interval_seconds": 120
  },
  "RearSeatHeaters": {
    "interval_seconds": 3600
  },
  "RemoteStartEnabled": {
    "interval_seconds": 120
  },
  "RightHandDrive": {
    "interval_seconds": 3600
  },
  "RoofColor": {
    "interval_seconds": 3600
  },
  "RouteLine": {
    "interval_seconds": 300
  },
  "RouteTrafficMinutesDelay": {
    "interval_seconds": 60
  },
  "RpWindow": {
    "interval_seconds": 120
  },
  "ScheduledChargingMode": {
    "interval_seconds": 60
  },
  "ScheduledChargingPending": {
    "interval_seconds": 60
  },
  "ScheduledChargingStartTime": {
    "interval_seconds": 60
  },
  "SeatHeaterLeft": {
    "interval_seconds": 120
  },
  "SeatHeaterRearCenter": {
    "interval_seconds": 120
  },
  "SeatHeaterRearLeft": {
    "interval_seconds": 120
  },
  "SeatHeaterRearRight": {
    "interval_seconds": 120
  },
  "SeatHeaterRight": {
    "interval_seconds": 120
  },
  "SeatVentEnabled": {
    "interval_seconds": 120
  },
  "SelfDrivingMilesSinceReset": {
    "interval_seconds": 300,
    "minimum_delta": 1
  },
  "SentryMode": {
    "interval_seconds": 300
  },
  "ServiceMode": {
    "interval_seconds": 120
  },
  "Setting24HourTime": {
    "interval_seconds": 3600
  },
  "SettingChargeUnit": {
    "interval_seconds": 3600
  },
  "SettingDistanceUnit": {
    "interval_seconds": 3600
  },
  "SettingTemperatureUnit": {
    "interval_seconds": 3600
  },
  "SettingTirePressureUnit": {
    "interval_seconds": 3600
  },
  "Soc": {
    "interval_seconds": 60
  },
  "SoftwareUpdateDownloadPercentComplete": {
    "interval_seconds": 300
  },
  "SoftwareUpdateExpectedDurationMinutes": {
    "interval_seconds": 300
  },
  "SoftwareUpdateInstallationPercentComplete": {
    "interval_seconds": 300
  },
  "SoftwareUpdateScheduledStartTime": {
    "interval_seconds": 300
  },
  "SoftwareUpdateVersion": {
    "interval_seconds": 300
  },
  "SpeedLimitMode": {
    "interval_seconds": 120
  },
  "SpeedLimitWarning": {
    "interval_seconds": 60
  },
  "SunroofInstalled": {
    "interval_seconds": 3600
  },
  "SuperchargerSessionTripPlanner": {
    "interval_seconds": 60
  },
  "TimeToFullCharge": {
    "interval_seconds": 60
  },
  "TpmsHardWarnings": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeFl": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeFr": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeRl": {
    "interval_seconds": 300
  },
  "TpmsLastSeenPressureTimeRr": {
    "interval_seconds": 300
  },
  "TpmsPressureFl": {
    "interval_seconds": 300
  },
  "TpmsPressureFr": {
    "interval_seconds": 300
  },
  "TpmsPressureRl": {
    "interval_seconds": 300
  },
  "TpmsPressureRr": {
    "interval_seconds": 300
  },
  "TpmsSoftWarnings": {
    "interval_seconds": 300
  },
  "Trim": {
    "interval_seconds": 3600
  },
  "ValetModeEnabled": {
    "interval_seconds": 120
  },
  "VehicleName": {
    "interval_seconds": 3600
  },
  "VehicleSpeed": {
    "interval_seconds": 10
  },
  "Version": {
    "interval_seconds": 3600
  },
  "WheelType": {
    "interval_seconds": 3600
  },
  "WiperHeatEnabled": {
    "interval_seconds": 120
  }
};

const MINIMAL_FIELDS: FieldPlan = {
  "ACChargingEnergyIn": {
    "interval_seconds": 120
  },
  "ACChargingPower": {
    "interval_seconds": 60
  },
  "BatteryLevel": {
    "interval_seconds": 120
  },
  "ChargeLimitSoc": {
    "interval_seconds": 300
  },
  "DCChargingEnergyIn": {
    "interval_seconds": 120
  },
  "DCChargingPower": {
    "interval_seconds": 60
  },
  "DetailedChargeState": {
    "interval_seconds": 60
  },
  "EnergyRemaining": {
    "interval_seconds": 300
  },
  "EstBatteryRange": {
    "interval_seconds": 300
  },
  "Gear": {
    "interval_seconds": 60
  },
  "InsideTemp": {
    "interval_seconds": 600
  },
  "Location": {
    "interval_seconds": 30
  },
  "Locked": {
    "interval_seconds": 300
  },
  "Odometer": {
    "interval_seconds": 60
  },
  "OutsideTemp": {
    "interval_seconds": 600
  },
  "PackCurrent": {
    "interval_seconds": 60
  },
  "PackVoltage": {
    "interval_seconds": 60
  },
  "RatedRange": {
    "interval_seconds": 300
  },
  "SentryMode": {
    "interval_seconds": 300
  },
  "Soc": {
    "interval_seconds": 60
  },
  "TpmsPressureFl": {
    "interval_seconds": 600
  },
  "TpmsPressureFr": {
    "interval_seconds": 600
  },
  "TpmsPressureRl": {
    "interval_seconds": 600
  },
  "TpmsPressureRr": {
    "interval_seconds": 600
  },
  "VehicleSpeed": {
    "interval_seconds": 30
  }
};

export const TELEMETRY_PLANS: Record<TelemetryPlanStep, FieldPlan> = {
  permanent: PERMANENT_FIELDS,
  lean: LEAN_FIELDS,
  minimal: MINIMAL_FIELDS,
};
