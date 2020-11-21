"use strict"

const fs      = require("fs").promises;
const process = require("process");

const bent     = require("bent");
const {Client} = require("tplink-smarthome-api");
const yargs    = require("yargs/yargs");


class KasaWatcher
{
    constructor(a_home_assistant_url,
                a_home_assistant_token)
    {
        this._kasa_client    = new Client();
        this._home_assistant = bent(`${a_home_assistant_url}/api/states/`,
                                    "POST",
                                    {Authorization: `Bearer ${a_home_assistant_token}`},
                                    [200, 201]);

        this._binary_sensors = {};
    }

    /**
     * @param {string} a_default_initial_state
     *     This is used as a tie breaker if equal number of switches have
     *     opposite initial states. Must be "on" or "off".
     */
    async addSwitchGroup(a_binary_sensor_name,
                         a_hosts,
                         a_default_initial_state)
    {
        if (this._binary_sensors[a_binary_sensor_name] !== undefined)
        {
            throw new RangeError();
        }

        const new_light_switches = await Promise.all(a_hosts.map(
            async (host) => {
                return await this._kasa_client.getDevice({host: host})
            }));

        let initial_states = {"on":  0,
                              "off": 0};
        await Promise.all(new_light_switches.map(
            async (light_switch) => {
                const switch_state = await this._requestSwitchState(light_switch);
                initial_states[switch_state] += 1;
            }));
        const other_state = a_default_initial_state == "off" ? "on" : "off";
        const new_state = (initial_states[a_default_initial_state] >= initial_states[other_state]
                           ? a_default_initial_state : other_state);

        this._binary_sensors[a_binary_sensor_name] = {light_switches: new_light_switches,
                                                      state:          new_state};

        await this._updateSensorState(a_binary_sensor_name, new_state);
    }

    async checkAllAndUpdate()
    {
        for (const binary_sensor in this._binary_sensors)
        {
            const previous_state = this._binary_sensors[binary_sensor].state;
            for (const light_switch of this._binary_sensors[binary_sensor].light_switches)
            {
                try
                {
                    const current_state = await this._requestSwitchState(light_switch);
                    if (current_state != previous_state)
                    {
                        this._binary_sensors[binary_sensor].state = current_state;
                        this._updateSensorState(binary_sensor, current_state)
                            .catch(console.log);
                        break;
                    }
                }
                catch (error)
                {
                    console.error(error);
                }
            }
        }
    }

    async _requestSwitchState(a_light_switch)
    {
        const info = await a_light_switch.getSysInfo();
        return info.relay_state ? "on" : "off";
    }

    async _updateSensorState(a_sensor_name, a_new_state)
    {
        await this._home_assistant(`binary_sensor.${a_sensor_name}`,
                                   {state: a_new_state});
    }
};


async function run(a_home_assistant_url,
                   a_home_assistant_token,
                   a_switch_groups,
                   a_interval_length_ms)
{
    try
    {
        let watcher = new KasaWatcher(a_home_assistant_url,
                                      a_home_assistant_token);

        for (const binary_sensor in a_switch_groups)
        {
            const switch_group = a_switch_groups[binary_sensor];
            await watcher.addSwitchGroup(binary_sensor,
                                         switch_group.hosts,
                                         switch_group.default_state);
        }

        setInterval(
            async() => {
                watcher.checkAllAndUpdate();
            },
            a_interval_length_ms);
    }
    catch (error)
    {
        console.error(error);
    }
}

async function readFile(file_path, encoding="utf8")
{
    let file = null;
    try
    {
        file = await fs.open(file_path, 'r')
        return await file.readFile({encoding: encoding});
    }
    catch (error)
    {
        return false;
    }
    finally
    {
        if (file)
        {
            await file.close()
        }
    }
}

async function main(argv)
{
    const INVALID_CLI_ARGS           =  1
    const CANNOT_READ_TOKEN_FILE     =  2;
    const CANNOT_READ_CONFIG_FILE    =  3;
    const CANNOT_PARSE_CONFIG_FILE   =  4;
    const CONFIGRUATION_INVALID      =  5
    const MISSING_HA_URL             =  6;
    const INVALID_HA_URL             =  7;
    const MISSING_POLL_INTERVAL      =  8;
    const INVALID_POLL_INTERVAL      =  9;
    const NON_NUMERIC_POLL_INTERVAL  = 10;
    const NOT_POSITIVE_POLL_INTERVAL = 11;
    const MISSING_BINARY_SENSORS     = 12;
    const EMPTY_BINARY_SENSORS       = 13;
    const INVALID_BINARY_SENSORS     = 14;

    const parsed_options = yargs(argv)
          .options({
              "ha-token-file": {
                  demandOption: true,
                  type:         "string",
                  description:
                  ("The path to the file containing the Home Assistant (HA) " +
                   "long-lived access token")
              },
              "configuration": {
                  alias:        "config",
                  demandOption: true,
                  type:         "string",
                  description:
                  ("The path the JSON configuration file.")
              }
          })
          .epilog("A simple client that will watch the specified TP-Link Kasa " +
                  "devices and update the associated Home Assistant binary "    +
                  "sensor when one of the device's state changes."              +
                  ``                                                                      + `\n` +
                  ``                                                                      + `\n` +
                  `Error Codes:`                                                          + `\n` +
                  `  Invalid command line arguments:        ${INVALID_CLI_ARGS}`          + `\n` +
                  `  Cannot read the HA token file:         ${CANNOT_READ_TOKEN_FILE}`    + `\n` +
                  `  Cannot read the configuration file:    ${CANNOT_READ_CONFIG_FILE}`   + `\n` +
                  `  Cannot parse the configuration file:   ${CANNOT_PARSE_CONFIG_FILE}`  + `\n` +
                  `  Configuration file invalid:            ${CONFIGRUATION_INVALID}`     + `\n` +
                  `  Configuration missing HA URL:          ${MISSING_HA_URL}`            + `\n` +
                  `  Invalid HA URL:                        ${INVALID_HA_URL}`            + `\n` +
                  `  Configuration missing poll interval:   ${MISSING_POLL_INTERVAL}`     + `\n` +
                  `  Invalid poll interval:                 ${INVALID_POLL_INTERVAL}`     + `\n` +
                  `  Non-numeric poll interval:            ${NON_NUMERIC_POLL_INTERVAL}`  + `\n` +
                  `  Poll interval is not positive:        ${NOT_POSITIVE_POLL_INTERVAL}` + `\n` +
                  `  Configuration missing binary sensors: ${MISSING_BINARY_SENSORS}`     + `\n` +
                  `  Binary sensors object empty:          ${EMPTY_BINARY_SENSORS}`       + `\n` +
                  `  Invalid binary sensors:               ${INVALID_BINARY_SENSORS}`     + `\n`
                 );
    const args = parsed_options.argv;

    const raw_ha_token = await readFile(args["ha-token-file"]);
    if (!raw_ha_token)
    {
        console.error(`Could not read the Home Assistant token file ` +
                      `"${args["ha-token-file"]}".`);
        process.exit(CANNOT_READ_TOKEN_FILE);
    }
    const ha_token = raw_ha_token.trim();

    const raw_configuration = await readFile(args["configuration"]);
    if (!raw_configuration)
    {
        console.error(`Could not read the JSON configuration file ` +
                      `"${args["configuration"]}".`);
        process.exit(CANNOT_READ_CONFIG_FILE);
    }
    const configuration = (() => {
        try
        {
            return JSON.parse(raw_configuration);
        }
        catch (error)
        {
            console.error(`Could not parse the JSON configuration file ` +
                          `"${args["configuration"]}".`);
            console.error(error.message);
            process.exit(CANNOT_PARSE_CONFIG_FILE);
        }
    })();

    if (Object.keys(configuration).length == 0)
    {
        console.error(`Configuration must be an object with the keys ` +
                      `"home_assistant_url", "poll_interval_ms", and ` +
                      `"binary_sensors".`);
        process.exit(CONFIGRUATION_INVALID);
    }

    if (configuration["home_assistant_url"] === undefined)
    {
        console.error(`Configuration is missing the "home_assistant_url" entry.`);
        process.exit(MISSING_HA_URL);
    }
    else if (!configuration["home_assistant_url"])
    {
        console.error(`The configuration value for "home_assistant_url" is ` +
                      `required must be a non-empty string.`);
        process.exit(INVALID_HA_URL);
    }

    if (configuration["poll_interval_ms"] === undefined)
    {
        console.error(`Configuration is missing the "poll_interval_ms" entry.`);
        process.exit(MISSING_POLL_INTERVAL);
    }
    else if (!configuration["poll_interval_ms"])
    {
        console.error(`The configuration value for "poll_interval_ms" is ` +
                      `required and must be a positive number.`);
        process.exit(INVALID_POLL_INTERVAL);
    }
    else if (typeof(configuration["poll_interval_ms"]) != "number" &&
             !(configuration["poll_interval_ms"] instanceof Number))
    {
        console.error(`The configuration value for "poll_interval_ms" must ` +
                      `be a positive number.`);
        process.exit(NON_NUMERIC_POLL_INTERVAL);
    }
    else if (configuration["poll_interval_ms"] <= 0)
    {
        console.error(`The configuration value for "poll_interval_ms" is ` +
                      `less than or equal to zero, but must be a positive number.`);
        process.exit(NOT_POSITIVE_POLL_INTERVAL);
    }

    if (configuration["binary_sensors"] === undefined)
    {
        console.error(`Configuration is missing the "binary_sensors" entry.`);
        process.exit(MISSING_BINARY_SENSORS);
    }
    else if (!configuration["binary_sensors"])
    {
        console.error(`The configuration value for "binary_sensors" is ` +
                      `required must be an Object.`);
        process.exit(EMPTY_BINARY_SENSORS);
    }
    else if (Object.keys(configuration["binary_sensors"]).length == 0)
    {
        console.error(`The configuration value for "binary_sensors" is empty. `+
                      `It must contain at least one key.`);
        process.exit(EMPTY_BINARY_SENSORS);
    }

    let binary_sensor_config_valid = true;
    for (const name in configuration["binary_sensors"])
    {
        const sensor_configuration = configuration["binary_sensors"][name];

        if (sensor_configuration["default_state"] === undefined)
        {
            console.error(`Binary sensor configuration for "${name}" is ` +
                          `missing the "default_state" entry.`);
            binary_sensor_config_valid = false;
            continue;
        }

        const default_state = sensor_configuration["default_state"];
        if ("on"  != default_state && "off" != default_state)
        {
            console.error(`Binary sensor configuration for "${name}" has an ` +
                          `invalid value for the "default_state" entry. It `  +
                          `must be one of "on" or "off"`);
            binary_sensor_config_valid = false;
            continue;
        }

        if (sensor_configuration["hosts"] === undefined)
        {
            console.error(`Binary sensor configuration for "${name}" is ` +
                          `missing the "hosts" entry.`);
            binary_sensor_config_valid = false;
            continue;
        }
        else if (!Array.isArray(sensor_configuration["hosts"]))
        {
            console.error(`Binary sensor configuration for "${name}" has an ` +
                          `invalid value for the "hosts" entry. It must be `  +
                          `an array containing at least one host string.`);
            binary_sensor_config_valid = false;
            continue;
        }
        else if (sensor_configuration["hosts"].length == 0)
        {
            console.error(`Binary sensor configuration for "${name}" has an `  +
                          `empty "hosts" entry. It must be an array at least ` +
                          `one host string.`);
            binary_sensor_config_valid = false;
            continue;
        }

        const hosts = sensor_configuration["hosts"];
        for (const i in hosts)
        {
            if (!hosts[i])
            {
                console.error(`Binary sensor configuration for "${name}" ` +
                              `host entry ${i} is empty. It must be a `    +
                              `non-empty string.`);
                binary_sensor_config_valid = false;
                continue;
            }
        }
    }
    if (!binary_sensor_config_valid)
    {
        process.exit(INVALID_BINARY_SENSORS);
    }


    run(configuration["home_assistant_url"],
        ha_token,
        configuration["binary_sensors"],
        configuration["poll_interval_ms"]);
}

main(process.argv);
