"use strict"

const fs      = require("fs").promises;
const process = require("process");

const bent     = require("bent");
const {Client} = require("tplink-smarthome-api");
const yargs    = require("yargs/yargs");


/**
 * A logger object that does nothing.
 *
 * This object is desinged to be used with the tplink-smarthome-api Client in
 * situations when it's automatic logging isn't desired.
 */
const NullLogger = {
    debug(){},
    info(){},
    warn(){},
    error(){}
};


/**
 * @typedef {string} SwitchState
 *
 * The state of a given switch. Must be one of "on", "off", or "disconnected".
 *
 * *Note:* The state "disconnected" should only be used when referring to the
 *         state of an individual switch and shopuld not be used when referring
 *         to the state of a group of switches.
 */


/**
 * This does all the work for watching Kasa switches and updating their
 * associated Home Assistant binary sensors.
 */
class KasaWatcher
{
    /**
     * Create a KasaWatcher.
     *
     * While this creates a new KasaWatcher you will need to call
     * {@link KasaWatcher#addSwitchGroup addSwitchGroup()} one or more times for
     * this to do anything useful. As multiple groups can be added there is
     * little reason to have more than one KasaWatch instance.
     *
     * @param {string} a_home_assistant_url
     *     The URL to Home Assistant.
     * @param {string} a_home_assistant_token
     *     The Home Assistant long-lived access token.
     * @param {number} a_kasa_timeout_ms
     *     The timeout to use when polling the Kasa devices, in miliseconds.
     * @param {bool} a_quiet
     *     Whether to reduce logging output, `true` for reduced output and
     *     `false` for regular verbose output.
     */
    constructor(a_home_assistant_url,
                a_home_assistant_token,
                a_kasa_timeout_ms,
                a_quiet)
    {
        let kasa_options = {defaultSendOptions: {timeout: a_kasa_timeout_ms}};
        if (a_quiet)
        {
            kasa_options.logger = NullLogger;
        }

        this._kasa_client    = new Client(kasa_options);
        this._home_assistant = bent(`${a_home_assistant_url}/api/states/`,
                                    "POST",
                                    {Authorization: `Bearer ${a_home_assistant_token}`},
                                    [200, 201]);

        /**
         * The collection mapping binary sensor names to objects containing the
         * array of switches and the current state.
         * @member {Object}
         */
        this._binary_sensors = {};

        /**
         * Whether or not a host is connected. A mapping from hostname to
         * boolean values.
         * @member {Object}
         */
        this._host_connected = {};
    }

    /**
     * Add a group of Kasa switches that will updat a single Home Assistant
     * binary sensor when one of them changes state.
     *
     * All switches will be immediately polled for their current state. Whatever
     * state the majority of the switches have will be used to set or update the
     * Home Assitant binary sensor immediately. In the case of a tie the
     * provided `a_default_initial_state` will be used.
     *
     * @param {string} a_binary_sensor_name
     *     The name of the Home Assistant binary sensor that will be updated
     *     whenever one of the switches state changes.
     * @param {string[]} a_hosts
     *     The host names or IP addresses of the Kasa switches to watch.
     * @param {string} a_default_initial_state
     *     This is used as a tie breaker if equal number of switches have
     *     opposite initial states. Must be "on" or "off".
     *
     * @throws Will trhow if unable to connect to one or more of the Kasa
     *         switches or Home Assistant.
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
        const other_state = this._getOppositeState(a_default_initial_state);
        const new_state = (initial_states[a_default_initial_state] >= initial_states[other_state]
                           ? a_default_initial_state : other_state);

        for (const host of a_hosts)
        {
            this._host_connected[host] = true;
        }
        this._binary_sensors[a_binary_sensor_name] = {light_switches: new_light_switches,
                                                      state:          new_state};

        await this._updateSensorState(a_binary_sensor_name, new_state);
    }

    /**
     * Check all switch groups and update their associated binary sensors.
     *
     * In parallel the state of every switch of every group is polled. If at
     * least one switch of the group has changed state the binary sensor's state
     * will be updated.
     *
     * *Note:* Unlike {@link KasaWatcher#addSwitchGroup addSwitchGroup()} this
     *         does not throw if unable to contact any switches. However it does
     *         log when connectivity is lost and recovered. If {@link KasaWatch}
     *         is not constructed in quiet mode every failed request will print
     *         out debug log information.
     */
    async checkAllAndUpdate()
    {
        await Promise.all(Object.keys(this._binary_sensors).map(
            (binary_sensor) => { return this._updateSensor(binary_sensor); }));
    }

    /**
     * Boolean not for switch state strings.
     *
     * @param {string} a_light_switch_state
     *     The original switch state for which the opposite is desired.
     *
     * @returns (string)  The state opposite of `a_light_switch_state`.
     *
     * @private
     */
    _getOppositeState(a_light_switch_state)
    {
        return a_light_switch_state == "off" ? "on" : "off";
    }

    /**
     * Log a message to the standard error output.
     *
     * Every message is preceeded by the current date and time in ISO format.
     *
     * @param {string} a_message  The message to log.
     */
    _log(a_message)
    {
        const now = new Date();
        console.error(`${now.toISOString()}: ${a_message}`);
    }

    /**
     * Check the state of the associated switches and update the binary sensor
     * if needed.
     *
     * This checks all of the switches states in parallel and updates the binary
     * sensor's state when the first switch whose state has changed is
     * encountered.
     *
     * @param {string} a_sensor_name
     *     The name of the binary sensor to update, if needed.
     *
     * @private
     */
    async _updateSensor(a_sensor_name)
    {
        let   binary_sensor  = this._binary_sensors[a_sensor_name];
        const light_switches = binary_sensor.light_switches;
        const change_state   = this._getOppositeState(binary_sensor.state);

        await Promise.all(light_switches.map(
            async (light_switch) => {
                const new_state = await this._tryRequestSwitchState(light_switch);
                if (new_state == change_state)
                {
                    await this._updateSensorState(a_sensor_name, new_state)
                        .catch(console.error);
                }
            }));
    }

    /**
     * Get the current state of a Kasa switch.
     *
     * @returns {string}  The switch's current state: "on" or "off".
     *
     * @throws Will throw if unable to connect to the Kasa switch.
     *
     * @private
     */
    async _requestSwitchState(a_light_switch)
    {
        const info = await a_light_switch.getSysInfo();
        return info.relay_state ? "on" : "off";
    }

    /**
     * Get the current state of a Kasa switch.
     *
     * This is a no-throw version of
     * {@link KasaWatch#_requestSwitchState _requestSwitchState()}.
     *
     * @returns {string} The switches current state: "on", "off", or
     * "disconnected" if unable to connect to the switch.
     *
     * @private
     */
    async _tryRequestSwitchState(a_light_switch)
    {
        const host                 = a_light_switch.host;
        const previously_connected = this._host_connected[host];
        try
        {
            const current_state = await this._requestSwitchState(a_light_switch);
            this._host_connected[a_light_switch.host] = true;
            if (!previously_connected)
            {
                this._log(`Reconnected to '${host}'.`);
            }
            return current_state;
        }
        catch
        {
            this._host_connected[a_light_switch.host] = false;
            if (previously_connected)
            {
                this._log(`Could not connect to '${a_light_switch.host}'.`);
            }
            return "disconnected";
        }
    }

    /**
     * Set or update the state of the Home Assistant binary sensor.
     *
     * *Note:* If the `a_new_state` is the same as the last state set for the
     *         binary sensor nothing will be done.
     *
     * @param {string} a_sensor_name
     *     The name of the Home Assistnat binary sensor to set or update.
     * @param {string} a_new_state
     *     The new state to set for the binary sensor.
     *
     * @throws This will throw if unable to connect to Home Assistant.
     */
    async _updateSensorState(a_sensor_name, a_new_state)
    {
        if (a_new_state == this._binary_sensors[a_sensor_name].state)
        {
            return;
        }

        this._binary_sensors[a_sensor_name].state = a_new_state;
        await this._home_assistant(`binary_sensor.${a_sensor_name}`,
                                   {state: a_new_state});
    }
};


/**
 * @typedef {Object} SwitchGroup
 *
 * An object that represents a group of Kasa switches that should be treated as
 * a single unit.
 *
 * @property {SwitchState} default_state
 *     The default state to use if there are an equal number of switches in
 *     opposing states at startup.
 * @property {string[]} hosts
 *     The hostnames or IP addresses of the swtiches in the group.
 */

/**
 * @typedef {Object} SwitchGroups
 *
 * An object that maps each Home Assistant binary sensor name to a
 * {@link SwitchGroup} of Kasa switches.
 */


/**
 * Actually run kasa-watch.
 *
 * This function sets up the watcher and handles the polling interval.
 *
 * @param {string} a_home_assistant_url
 *     The URL to Home Assistant.
 * @param {string} a_home_assistant_token
 *     The Home Assistant long-lived access token.
 * @param {number} a_kasa_timeout_ms
 *     The timeout to use when polling the Kasa devices, in miliseconds.
 * @param {SwitchGroups} a_switch_groups
 *     The groups of Kasa switches to poll and their associated Home Assistant
 *     binary sensor names.
 * @param {number} a_interval_length_ms
 *     The interval at which to poll the state of the Kasa devices, in
 *     miliseconds.
 * @param {bool} a_quiet
 *     Whether to reduce logging output, `true` for reduced output and `false`
 *     for regular verbose output.
 */
async function run(a_home_assistant_url,
                   a_home_assistant_token,
                   a_kasa_timeout_ms,
                   a_switch_groups,
                   a_interval_length_ms,
                   a_quiet)
{
    try
    {
        let watcher = new KasaWatcher(a_home_assistant_url,
                                      a_home_assistant_token,
                                      a_kasa_timeout_ms,
                                      a_quiet);

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

/**
 * Read the contents of a file directly.
 *
 * @param {string} a_file_path  The path, on disk, to the file to be read.
 * @param {string} a_encoding   The encoding to use when reading the file.
 *
 * @returns {string|Buffer}
 *     The contents of the file as a string if appropriate for the encoding
 *     used otherwise as a Buffer.
 */
async function readFile(a_file_path, a_encoding="utf8")
{
    let file = null;
    try
    {
        file = await fs.open(a_file_path, 'r')
        return await file.readFile({encoding: a_encoding});
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

/**
 * The main function which handles starting kasa-watch.
 *
 * This handles the command-line arguments as well as validating the
 * configuration file.
 *
 * @param {string[]} argv  The command line aguments.
 */
async function main(argv)
{
    const INVALID_CLI_ARGS           =  1;
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
    const NON_NUMERIC_KASA_TIMEOUT   = 15;
    const NOT_POSITIVE_KASA_TIMEOUT  = 16;

    const parsed_options = yargs(argv)
          .options({
              "verbose": {
                  type:        "boolean",
                  default:     false,
                  alias:       "v",
                  description: "Print more information when running."
              },
              "ha-token-file": {
                  demandOption: true,
                  type:         "string",
                  description:
                  ("The path to the file containing the Home Assistant (HA) " +
                   "long-lived access token.")
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
                  `  Invalid binary sensors:               ${INVALID_BINARY_SENSORS}`     + `\n` +
                  `  Non-numeric Kasa timeout:             ${NON_NUMERIC_KASA_TIMEOUT}`   + `\n` +
                  `  Kasa timeout is not positive:         ${NOT_POSITIVE_KASA_TIMEOUT}`  + `\n`
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


    let kasa_timeout_ms = 10e3; // 10s, matching the tplink-smarthome-api default.
    if (configuration["kasa_timeout_ms"] !== undefined)
    {
        if (typeof(configuration["kasa_timeout_ms"]) != "number" &&
            !(configuration["kasa_timeout_ms"] instanceof Number))
        {
            console.error(`The configuration value for "kasa_timeout_ms" must ` +
                          `be a positive number.`);
            process.exit(NON_NUMERIC_KASA_TIMEOUT);
        }
        else if (configuration["kasa_timeout_ms"] <= 0)
        {
            console.error(`The configuration value for "kasa_timeout_ms" is ` +
                          `less than or equal to zero, but must be a ` +
                          `positive number.`);
            process.exit(NOT_POSITIVE_KASA_TIMEOUT);
        }

        kasa_timeout_ms = configuration["kasa_timeout_ms"];
    }


    run(configuration["home_assistant_url"],
        ha_token,
        kasa_timeout_ms,
        configuration["binary_sensors"],
        configuration["poll_interval_ms"],
        !args["verbose"]);
}

main(process.argv);
