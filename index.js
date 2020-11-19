"use strict"

const bent     = require("bent");
const {Client} = require("tplink-smarthome-api");


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
                   a_interval_length)
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
            a_interval_length);
    }
    catch (error)
    {
        console.error(error);
    }
}

run("http://192.168.1.2",
    "",
    {"study_lights": {hosts:["192.168.1.10",
                             "192.168.1.11",
                             "192.168.1.12"],
                      default_state: "off"}},
    1000);
