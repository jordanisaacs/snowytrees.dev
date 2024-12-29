+++
title = "NixOS Configuration with Flakes"
date = 2021-09-11

[taxonomies]
series=["NixOS Desktop"]
tags=["NixOS", "Nix", "X11", "Linux"]
+++

# My Flakes Philosophy

In this blog post I will overview how to setup flakes with [NixOS](https://nixos.org/) and [home-manager](https://github.com/nix-community/home-manager), and my approach to system configuration. I will also take care to introduce the Nix language and provide links to learning more. This is the first post in my *NixOS Desktop* series which I will use to explore my Nix and Linux journey. I installed Linux/NixOS for the first time one month ago so it is following me in real time from beginner to eventually, hopefully master :). This post is heavy on the Nix as I am laying the foundation for future posts. But in the future expect it to be much more balanced. For a sneak peek of what is to come check out my [dotfiles](https://github.com/jordanisaacs/dotfiles).

<!-- more -->

NixOS and home-manager have extensive options but most of them only need to be configured once. Things like sound settings, boot, etc. can be abstracted into groups. Therefore I leverage the Nix module system, which I will go into in detail, to create high level options that makes setting up new systems and profiles easy.

Before I get into the details, I have to thank **Wil Taylor** for his amazing NixOS series (see below) and his [dotfiles](https://github.com/wiltaylor/dotfiles) repository for providing a baseline. My configuration started off as a copy of his and has since evolved but much remains similar. His name will appear often for credit in this post. He uses a *role* system which involves importing configuration files, while I prefer to use the built-in module system which provides more flexibility.

**Note**: While flakes are technically unstable, I have been daily driving them with no issues.

# Setting up NixOS

There has been much written on setting up NixOS so if you don't have it installed check out these resources:

* [Graham Christensen Dell Setup](https://grahamc.com/blog/nixos-on-dell-9560)
    * Setting up partitions and encryption (luks)
* [Wil Taylor's NixOS series](https://www.youtube.com/watch?v=QKoQ1gKJY5A&list=PL-saUBvIJzOkjAw_vOac75v-x6EzNzZq-)
    * Overview of how to install NixOS and basic flake introduction. Also overviews how to set up an initial NixOS flake configuration. I used the series to get started with NixOS/Flakes and highly recommend watching the full series.

# Introduction to Flakes

I will be going into a little of how flakes work but there are already some great writeups. My go-to when I need to brush up is [Practical Nix Flakes](https://serokell.io/blog/practical-nix-flakes). Also Wil Taylor's series provides an overview.

See the [wiki](https://nixos.wiki/wiki/Flakes) for installation and more information. I recommend following the system-wide installation as the `nixFlakes` installation option will not work as we need access to the `nixos-rebuild ***** --flake` command.

# Writing flake.nix

Assuming you have Nix installed with flakes enabled we will start our journey to creating a configuration. The core of the system configuration is `flake.nix`. This is the file that all our nix flake commands look for.

## Initialize flake

First create your directory that will host your configuration. I followed Wil Taylor's lead (see NixOS series) and created `.dotfiles` folder in my home directory. In your folder call `nix flake init` which will create a basic flake. You should see:

```nix
{ # .dotfiles/flake.nix
  description = "A very basic flake";

  outputs = { self, nixpkgs }: {

    packages.x86_64-linux.hello = nixpkgs.legacyPackages.x86_64-linux.hello;

    defaultPackage.x86_64-linux = self.packages.x86_64-linux.hello;

  };
}
```

We can update the description to signify that this is our system config `description = "System config";`.

## Setting inputs

Inputs are implicit in `nix flake init`. But we want to make it explicit and add extra inputs such as home-manager.

I am a believer in [home-manager](https://github.com/nix-community/home-manager) for configuring my user environment. It allows me to have my user config follow the same philosophies of my NixOS config. Combined with its support of flakes, all configuration can be in a single github repository and is reproducible.

I also use unstable nixpkgs (see [channels](https://nixos.wiki/wiki/Nix_channels)) as the default which is a preference of mine. I have home-manager follow my nixpkgs so everything is following my own `flake.lock`. For more information on inputs check out the [manual](https://nixos.org/manual/nix/unstable/command-ref/new-cli/nix3-flake.html#flake-inputs).

URLs can be in any format as described by the [schema](https://nixos.wiki/wiki/Flakes#Input_schema). By default it assumes that any repository as input is a `flake`. Therefore it looks for a `flake.nix` file in the base directory.

```nix
{ # .dotfiles/flake.nix
  #...

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  #...
}
```

All external inputs should be placed in the inputs. These inputs are what Nix uses to generate the `flake.lock` file. The lock file sets the versions being used which is what provides the reproducibility. As our home-manager and system configuration are in a single flake, updating our packages will be as simple as `nix flake update`.

## Setting up outputs

The outputs of a flake are where our actual configuration will be. However, keeping our entire configuration in `flake.nix` will quickly get unwieldy. So this is where we will be importing our own function for building users and systems.

```nix
{ # .dotfiles/flake.nix
  #...

  outputs = { nixpkgs, home-manager, ...}@inputs:
  let
    inherit (nixpkgs) lib;
    
    util = import ./lib {
      inherit system pkgs home-manager lib; overlays = (pkgs.overlays);
    };

    inherit (util) user;
    inherit (util) host;

    pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
        overlays = [];
    };

    system = "x86_64-linux";
  in {
    homeManagerConfigurations = {
      jd = user.mkHMUser {
        # ...
      };
    };

    nixosConfigurations = {
      laptop = host.mkHost {
        # ...
      };
    };
  };
}
```

### Nix Language

There is a lot to unpack here so I'll start with what the Nix Language is doing. If you are experienced with Nix, you can skip this section. I will go over the language briefly as we go along and provide links but I highly recommend James Fisher's [Nix by example](https://jameshfisher.com/2014/09/28/nix-by-example/) for learning Nix.

The `let` section:

* The `output` is a [function](https://nixos.wiki/wiki/Nix_Expression_Language#Functions) that is called with the inputs declared earlier.
* We declare local variables using the `let ... in` syntax. Nix pills has a good [overview](https://nixos.org/guides/nix-pills/basics-of-language.html#idm140737320575616).
* In our let we utilize `inherit` which lets us copy variables easily. The manual has a nice [description](https://nixos.org/manual/nix/stable/#idm140737321959024).
* We create our own `pkgs` which imports `nixpkgs` with our configuration of choice. I install non-free packages like *obsidian* and *zoom-us* so I make sure it is allowed (see [wiki](https://nixos.wiki/wiki/FAQ/How_can_I_install_a_proprietary_or_unfree_package%3F))
* We import our custom functions using `import ./lib { #parameters }`. Importing is like calling a function, see the [Nix Pills](https://nixos.org/guides/nix-pills/functions-and-imports.html)
* We will not cover `overlays` in this post as they are not important to the task at hand, but if you are interested check out the [wiki](https://nixos.wiki/wiki/Overlays).

The `in` section:

* We call our homemade imported functions `user.mkHMUser` and `host.mkHost` with parameters. We will write out these functions and their parameters next.

### Homemade Functions

Our homemade funtions `mkHost` and `mkHMUser` are our abstraction away from base option settings. Our configuration options will be parameters to this function which will take them act on them build our system and home-manager flakes. You can have as many `homeManagerConfigurations` and `nixosConfigurations` as you want enabling you to have every OS config and User config in one reproducible github repository ＼(＾▽＾)／.

# Library Functions

Before I jump into writing our functions, I have to credit the one and only **Wil Taylor** for providing the idea and original code (see [here](https://github.com/wiltaylor/dotfiles/tree/master/lib))

## ./lib default.nix

When you import a directory, Nix automatically looks for a `default.nix` file to run. So this is where we will import our functions.

```nix
# .dotfiles/lib/default.nix
{ pkgs, home-manager, system, lib, overlays, ... }:
rec {
  user = import ./user.nix { inherit pkgs home-manager lib system overlays; };
  host = import ./host.nix { inherit system pkgs home-manager lib user; };
}
```

Notice we use `rec` around our imports. This lets us self reference so we can call `util.user` in our `flake.nix`. See [wiki](https://nixos.wiki/wiki/Nix_Expression_Language#rec_statement).

# System Configuration

We will start with learning how to make a system configuration. In this section I will introduce you to Nix Modules which are fundamental to NixOS.

## mkHost

This function is what we use to make system configurations. There are three parts to the parameters, hardware/kernel options and the `systemConfig`, and `users`. The hardware/kernel options are mapped one-to-one to NixOS options, while `systemConfig` will be our abstracted configuration module.

```nix
# .dotfiles/lib/host.nix
{ system, pkgs, home-manager, lib, user, ... }:
with builtins;
{
  mkHost = { name, NICs, initrdMods, kernelMods, kernelParams, kernelPackage,
    systemConfig, cpuCores, users, wifi ? [],
    gpuTempSensor ? null, cpuTempSensor ? null
  }:
  let
    networkCfg = listToAttrs (map (n: {
      name = "${n}"; value = { useDHCP = true; };
    }) NICs);

    userCfg = {
      inherit name NICs systemConfig cpuCores gpuTempSensor cpuTempSensor;
    };

    sys_users = (map (u: user.mkSystemUser u) users);
  in lib.nixosSystem {
    inherit system;

    modules = [
      {
        imports = [ ../modules/system ] ++ sys_users;

        jd = systemConfig;

        environment.etc = {
          "hmsystemdata.json".text = toJSON userCfg;
        };

        networking.hostName = "${name}";
        networking.interfaces = networkCfg;
        networking.wireless.interfaces = wifi;

        networking.networkmanager.enable = true;
        networking.useDHCP = false;

        boot.initrd.availableKernelModules = initrdMods;
        boot.kernelModules = kernelMods;
        boot.kernelParams = kernelParams;
        boot.kernelPackages = kernelPackage;

        nixpkgs.pkgs = pkgs;
        nix.maxJobs = lib.mkDefault cpuCores;

        system.stateVersion = "21.05";
      }
    ];
  };
}
```

### with Statement

Another large piece of code to unpack! Starting at the beginning we have `with builtins;`. This lets us call builtin functions without using `builtins.***`. See [Nix Pills](https://nixos.org/guides/nix-pills/basics-of-language.html#idm140737320565152). All the builtin functions can be found in the [manual](https://nixos.org/manual/nix/unstable/expressions/builtins.html).

### networkCfg

Next up is `networkCfg`. The NICs variable is a list of strings. So `builtins.map` turns the list of strings into a list of `{ name = "${nic}"; value = { useDHCP = true; }`. Then we call `builtins.listToAttrs` which maps the list of name/value pairs to an attribute set `{ "${nic}" = { useDHCP = true; } }`.

Now in the output we have `networking.interfaces = networkCfg` (see nixOS [options](https://search.nixos.org/options?channel=21.05&show=networking.interfaces.%3Cname%3E.useDHCP&from=0&size=50&sort=relevance&type=packages&query=networking.interfaces)). Our list of strings was turned into suitable networking interfaces. We have `useDHCP = true` so we can have IP addresses auto-assigned ([wikipedia](https://en.wikipedia.org/wiki/Dynamic_Host_Configuration_Protocol)).

### userCfg

`userCfg` doesn't actually configure anything. Instead it is used to pass information about the system to our user (aka home-manager) configurations. We use `builtins.toJSON` to save the attribute set to `/etc/hmsystemdata.json`. Passing data in between the system and user is important for settings up things like `.xinitrc` if system is not using a display manager.

### sysUsers

All of our users need to be declared in the system configuration. Therefore we map our list of `user` attributes sets that we passed from `flake.nix` to the `user.mkSystemUser` function.

Now is a good time to set up our `user.nix` file with its first function.

```nix
# .dotfiles/lib/user.nix
{ pkgs, home-manager, lib, system, overlays, ... }:
with builtins;
{
  mkHMUser = { # To be completed later };

  mkSystemUser = { name, groups, uid, shell, ... }:
  {
    users.users."${name}" = {
      name = name;
      isNormalUser = true;
      isSystemUser = false;
      extraGroups = groups;
      uid = uid;
      initialPassword = "helloworld";
      shell = shell;
    };
  };
}
```

These are some basic user settings. See [here](https://search.nixos.org/options?channel=21.05&show=users.users.%3Cname%3E.isNormalUser&from=0&size=50&sort=relevance&type=packages&query=isnormaluser) for info on `isNormalUser`, `isSystemUser`, and `uid`. We set an initial password but it should be changed immediately after setup. We set the shell to the chosen shell package. The groups is a list of any groups the user should be a part of.

### Kernel Goodies, etc.

A whole bunch of kernel settings, some networking settings, etc. The philosophy behind not abstracting these settings is that they are essential to any system and should be explicitly chosen.

### lib.nixosSystem

This is the function that produces our NixOS system flake. I was unable to find a high level description of what it does internally but if your interested here is the [source code](https://github.com/NixOS/nixpkgs/blob/master/flake.nix). Warning: it is very complex. What follows is my understanding of what `lib.nixosSystem` does.

The structure is laid out by the [NixOS wiki](https://nixos.wiki/wiki/Flakes#Using_nix_flakes_with_NixOS). We set `system` and `modules`. Ooh! Our first code mentioning modules. NixOS takes in a list of module files. But what is a module!?

###  Modules!

According to the wiki [modules](https://nixos.wiki/wiki/Module) are Nix files that declare *options* for other modules to *define*. But what exactly does that mean? It is illustrated well when you see the structure of a module.

```nix
{
  imports = [
    # paths to other modules
  ];

  options = {
    # option declarations
  };

  config = {
    # option definitions
  };
}
```

#### Config

Working backwards lets start with the config. This is where you act on your configuration. Lets say a user set `wifi.enable = true`. If `wifi.enable = true`, then we need install packages and run systemd services (or whatever enabling wifi does). But wait, to do that we are setting other options. Thats why the NixOS wiki says other modules *define*! Each module acts on other modules. So then where are these options coming from? The options section!

#### Options

Every configuration option needs to be declared as an option. Attempting to access something in the config that isn't declared will result in an error. For all the declaration options check out, you guessed it, the [wiki](https://nixos.wiki/wiki/Declaration).

#### Imports

As every option needs to be declared, we want modules to interact with each other. The imports section lets you bring in your other modules and combine them.

### Back to lib.nixosSystem

Now that we have an understanding of Nix modules, lets re-examine what is happening with `modules`. If you have ever checked out [NixOS Options Search](https://search.nixos.org/options) you will see *10,000+* options advertised. NixOS is really just one massive community module for setting up a Linux system!

This means when we provide our NixOS configuration, we can also import in our own modules that define new options. Its as simple as that: we provide our own high level options that set built-in NixOS options.

### Imports

We import our custom module system from `./modules/system` and the config outputs from `mkSystemUser`. The `++` operator is just concatenating the lists. [Nix Operators](https://nixos.org/manual/nix/unstable/expressions/language-operators.html)

### jd & systemConfig

To prevent any accidental conflicts between the NixOS module system and my abstracted module system, all custom options are in the `jd.***` attribute set. However, from `flake.nix` you would never know this as I set `jd = systemConfig`. Now that you know how to make a system flake lets go back to our `flake.nix` and configure our first system!

## System flake.nix

Here is an example laptop configuration that I have in use. I copied and pasted the `NICs`, `initrdMods`, and `kernelMods` from my system's auto-generated `hardware.nix` file. I am leaving systemConfig blank as that is your freedom spot to create your own settings. At the end of the blog I will have an example module for inspiration.

```nix
{# .dotfiles/flake.nix
laptop = host.mkHost {
  name = "laptop";
  NICs = [ "enp0s31f6" "wlp2s0" ];
  kernelPackage = pkgs.linuxPackages;
  initrdMods = [ "xhci_pci" "nvme" "usb_storage" "sd_mod" "rtsx_pci_sdmmc" ];
  kernelMods = [ "kvm-intel" ];
  kernelParams = [];
  systemConfig = {
    # your abstracted system config
  };
  users = [{
    name = "jd";
    groups = [ "wheel" "networkmanager" "video" ];
    uid = 1000;
    shell = pkgs.zsh;
  }];
  cpuCores = 4;
};
}
```

# User Configuration 

Now that you know how Nix Modules work, this next part should be a breeze. home-manager is just a massive community module for configuring user environments rather than the operating system.

## mkHMUser

`mkHMUser` is the function used to build our home manager flake. We have two parameters, `username` and `userConfig`. `userConfig` is the user equivalent of `systemConfig` which is our settings passed to our custom module.

```nix
# .dotfiles/lib/user.nix
{ pkgs, home-manager, lib, system, overlays, ... }:
with builtins;
{
  mkHMUser = {userConfig, username}:
    home-manager.lib.homeManagerConfiguration {
      inherit system username pkgs;
      stateVersion = "21.05";
      configuration =
        let
          trySettings = tryEval (fromJSON (readFile /etc/hmsystemdata.json));
          machineData = if trySettings.success then trySettings.value else {};

          machineModule = { pkgs, config, lib, ... }: {
            options.machineData = lib.mkOption {
              default = {};
              description = "Settings passed from nixos system configuration. If not present will be empty";
            };

            config.machineData = machineData;
          };
        in {
          jd = userConfig;

          nixpkgs.overlays = overlays;
          nixpkgs.config.allowUnfree = true;

          systemd.user.startServices = true;
          home.stateVersion = "21.05";
          home.username = username;
          home.homeDirectory = "/home/${username}";

          imports = [ ../modules/users machineModule ];
        };
      homeDirectory = "/home/${username}";
    };
  
  # ...
}
```

### machineModule

This is our first encounter of a custom built module! It is very simple but shows how all `config.***` need to be declared. While we never manually change what `config.machineData` is, it still needs to be declared as an option. The point of machineModule is so we can access our exported `hmsystemdata.json` in our custom modules. When accessing the data from our custom modules, all we need to do is access `config.machineData.***`!

### Home Manager Flake

I am using the function `home-manager.lib.homeManagerConfiguration` from home-manager's [flake.nix](https://github.com/nix-community/home-manager/blob/039f786e609fdb3cfd9c5520ff3791750c3eaebf/flake.nix#L30). I copied the relevant code below.

```nix
{ # home-manager flake.nix
homeManagerConfiguration = { configuration, system, homeDirectory
  , username, extraModules ? [ ], extraSpecialArgs ? { }
  , pkgs ? builtins.getAttr system nixpkgs.outputs.legacyPackages
  , check ? true, stateVersion ? "20.09" }@args:
  assert nixpkgs.lib.versionAtLeast stateVersion "20.09";

  import ./modules {
    inherit pkgs check extraSpecialArgs;
    configuration = { ... }: {
      imports = [ configuration ] ++ extraModules;
      home = { inherit homeDirectory stateVersion username; };
      nixpkgs = { inherit (pkgs) config overlays; };
    };
  };
}
```

The home-manager function `home-manager.lib.homeManagerConfiguration` is similar to `lib.nixosSystem`. Rather than a list of `modules` it takes in a single `configuration`. But the outcome is the same, we can import our custom module at `.dotfiles/modules/users` and machineModule to expand the options. Just like with the system config, we set `jd = userConfig`.

Make sure to pass in the other parameters (`system`, `homeDirectory`, `username`, and `pkgs`). As you can see, home manager defaults to `stateVersion = "21.09"` so make sure to set `stateVersion = "21.05"` if it is 21.05 or else an error will occur.

That was much faster to get through then the system configuration setting because the concepts repeat! Its now time to start writing your own modules for configuration.

# Writing Modules

When writing your own modules you will be abstracting existing NixOS and home-manager modules. Therefore you should have all the options handy. Use [NixOS Search](hhttps://search.nixos.org/options) when doing system configurations, and [home-manager Appendix A](https://rycee.gitlab.io/home-manager/options.html) when doing user configurations.

If you want inspiration for modules to write check out my [modules folder](https://github.com/jordanisaacs/dotfiles/tree/master/modules). A good understanding of Nix and the builtin functions makes writing modules much easier. A great resource for builtin functions is teu5us' [website](https://teu5us.github.io/nix-lib.html). Also don't be afraid to google and read `nixpkgs` github source. Most of the time its not actually that complicated.

## Example Module

This module is taken from my user setting for git.

```nix
# .dotfiles/modules/users/default.nix
{ pkgs, config, lib, ... }:

{
  imports = [
    ./git
  ];
}
```

We are utilizing module imports to group each module file into nice categories. Remember that when importing a directory, Nix looks for `default.nix`

```nix
# .dotfiles/modules/users/git/default.nix
{ pkgs, config, lib, ... }:
with lib;

let
  cfg = config.jd.git;
in {
  options.jd.git = {
    enable = mkOption {
      description = "Enable git";
      type = types.bool;
      default = false;
    };

    userName = mkOption {
      description = "Name for git";
      type = types.str;
      default = "Jordan Isaacs";
    };

    userEmail = mkOption {
      description = "Email for git";
      type = types.str;
      default = "your@email.com";
    };
  };

  config = mkIf (cfg.enable) {
    programs.git = {
      enable = true;
      userName = cfg.userName;
      userEmail = cfg.userEmail;
      extraConfig = {
        credential.helper = "${
            pkgs.git.override { withLibsecret = true; }
          }/bin/git-credential-libsecret";
      };
    };
  };
}
```

I create a shortcut to the current config, by setting `cfg = config.jd.git`.

There is an `enable` option that allows us to easily turn on and off git. This way instead of having to remove any custom configuration, just set `enable = false` the attribute set won't be made anymore due to `mkIf`. The `userName` and `userEmail` have defaults that I should never have to change, but are there in case I do. And I have git setup to always use my keyring (what is a keyring, and setting it up will be in a future blogpost!) instead of plaintext (from [wiki](https://nixos.wiki/wiki/Git)).

Now from `flake.nix` all we have to do is the following. Notice the `jd.git.***` is hidden.

```nix
{ # flake.nix
  jd = user.mkHMUser {
    userConfig = {
      git.enable = true;
    };
  };
}
```

# Flakes Actions

Now that you have written the modules you want, you probably are wondering how you actually interact your flakes. However, before we can do that we need to get a git repository set up.

## Git & Flakes

Nix requires your flakes to be in a git repository and all *new* files that are accessed by the flake to be staged (but not necessarily committed). Attempting to access a newly created file that was not staged will result in the flake saying the file was not found. However, once the file is staged any changes can be made to it without staging or committing. If you do not commit you will see a warning: `warning: Git tree '*dir-path*' is dirty`. It is just letting you know you are building a flake with uncommitted changes.

## Applying Flake

While writing modules is fun, the whole point is to create a usable system! That is only possible by building and activating your flakes.

### System

Applying your system flakes with your system is as easy as appending `--flake '.#'` to your `sudo nixos-rebuild ***` command. Make sure to run the command when your working directory is `.dotfiles` or wherever your flake is located.

### User

Applying your user flake is a little more complicated. First you need to build the flake then activate it.

```bash
nix build --impure .#homeManagerConfigurations.$USER.activationPackage
./result/activate
```

`--impure` is required because we are importing `hmsystemdata.json`. It means we are not *fully* reproducible because the file (and thus output) could change without updating the flake.

## Updating Flake

As our system and user are all in the same flake, updating the flake is as easy as calling `nix flake update` when in the directory.

## Cleaning System

It is still a normal NixOS system so you can call `nix-store --gc` and `nix-store --optimize`.

# Finishing up

Well now you hopefully have a functioning NixOS and home-manager flake with a better understanding of Nix! If you have any questions, or find any issues with anything in this post feel free to leave a github issue at my [dotfiles repo](https://github.com/jordanisaacs/dotfiles)
