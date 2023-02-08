/**
 * TODO: Stripe should send an email confirming purchase
 */

import { parse } from 'qs';
import { fail, redirect } from '@sveltejs/kit';
import { stripe } from '$lib/stripe-api';
import type { Stripe } from 'stripe';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { printfulApi } from '$lib/printful-api';
import { sanctionedCountryCodes } from '$lib/utils';
import { sdk } from '$lib/graphql/sdk';
import type { Variant } from '$lib/graphql/types';

type Address = {
  address1: string;
  address2: string;
  city: string;
  zip: string;
  country_code: string;
  state_code?: string;
};

interface StrongVariant extends Omit<Variant, 'details'> {
  printfulVariantId: string;
  details: {
    currency: string;
    name: string;
    files: Array<{ thumbnail_url: string }>;
    baseVariantId: string;
    price: number;
  };
}

interface CartRequestBody {
  items: Array<{
    id: string;
    quantity: number;
  }>;
  shippingAddress: Address;
}

interface StateCountry {
  code: string;
  name: string;
}

function sortStateCountryAlphabetically (a: StateCountry, b: StateCountry) {
  const aName = a.name.toUpperCase();
  const bName = b.name.toUpperCase();

  if (aName > bName) {
    return 1;
  } else if (aName < bName) {
    return -1;
  } else {
    return 0;
  }
}

export const load: PageServerLoad = async () => {
  const countryData = await printfulApi('/countries');

  let countries: Array<StateCountry> = [];
  let statesByCountry: Record<string, Array<StateCountry>> = {};
  for (let country of countryData) {
    const { code, name, states } = country;
    if (!sanctionedCountryCodes.includes(code)) {
      countries = [...countries, { code, name }];
      statesByCountry[code] = states?.sort(sortStateCountryAlphabetically);
    }
  }
  countries = countries.sort(sortStateCountryAlphabetically);

  return {
    title: 'Cart',
    countries,
    statesByCountry
  };
};

export const actions: Actions = {
  default: async ({ request }) => {
    let { items, shippingAddress } = parse(await request.text()) as unknown as CartRequestBody;

    if (!items?.length) {
      return fail(400, { cartEmpty: true });
    }

    const errors: any = {
      shippingAddress: {}
    };
    if (!shippingAddress.address1) {
      errors.shippingAddress.hasErrors = true;
      errors.shippingAddress.address1 = { missing: true };
    }
    if (!shippingAddress.city) {
      errors.shippingAddress.hasErrors = true;
      errors.shippingAddress.city = { missing: true };
    }
    if (!shippingAddress.zip) {
      errors.shippingAddress.hasErrors = true;
      errors.shippingAddress.zip = { missing: true };
    }
    if (!shippingAddress.country_code) {
      errors.shippingAddress.hasErrors = true;
      errors.shippingAddress.country_code = { missing: true };
    }
    if (sanctionedCountryCodes.includes(shippingAddress.country_code)) {
      errors.shippingAddress.hasErrors = true;
      errors.shippingAddress.country_code = { invalidRegion: true };
    }
    if (!shippingAddress.state_code) {
      errors.shippingAddress.hasErrors = true;
      errors.shippingAddress.state_code = { missing: true };
    }

    if (errors.shippingAddress?.hasErrors) {
      return fail(400, errors);
    }

    let recipientShippingAddress = shippingAddress;
    if (recipientShippingAddress.state_code === 'N/A') {
      const { state_code, ...rest } = recipientShippingAddress;
      recipientShippingAddress = rest;
    }

    // Get product variant details from DB
    const { variants } = await sdk.Variants({
      variantIds: items.map((v) => v.id)
    });
    const typedVariants = variants ?? [] as Array<StrongVariant>;

    // TODO: (maybe) return error if could not find all products in DB
    // Maybe user had super old session data hanging around after products have been changed... probably not very likely given that this is sessionStorage.

    // Create lookup table using variant ID as the key
    const variantDetailsHash: Record<string, Omit<StrongVariant, 'id'>> = typedVariants.reduce(
      (accumulatorHash, { id, ...rest }) => {
        return {
          ...accumulatorHash,
          [id]: rest
        };
      },
      {}
    );

    // Format line_item data for Stripe
    const line_items: Array<Stripe.Checkout.SessionCreateParams.LineItem> = items.map(
      ({ id, quantity }) => {
        const variant = variantDetailsHash[id];
        return {
          price_data: {
            currency: variant.details.currency,
            product_data: {
              name: variant.details.name,
              images: [variant.details.files.at(-1)?.thumbnail_url as string],
              metadata: {
                printfulVariantId: variant.printfulVariantId,
                baseVariantId: variant.details.baseVariantId
              }
            },
            unit_amount: variant.details.price * 100
          },
          quantity,
        };
      }
    );

    // Get shipping rates from Printful
    const itemsForPrintfulShipping = line_items.map((item) => {
      return {
        variant_id: item.price_data?.product_data?.metadata?.baseVariantId,
        quantity: item.quantity
      };
    });
    const shippingRates = await printfulApi('/shipping/rates', {
      method: 'POST',
      body: JSON.stringify({
        recipient: recipientShippingAddress,
        items: itemsForPrintfulShipping
      })
    });

    const stripeShippingOptions: Array<Stripe.Checkout.SessionCreateParams.ShippingOption> =
      shippingRates.map(
        (shippingRate: any): Stripe.Checkout.SessionCreateParams.ShippingOption => ({
          shipping_rate_data: {
            display_name: shippingRate.name,
            type: 'fixed_amount',
            fixed_amount: {
              amount: parseFloat(shippingRate.rate) * 100,
              currency: 'USD'
            },
            delivery_estimate: {
              minimum: {
                unit: 'day',
                value: shippingRate.minDeliveryDays
              },
              maximum: {
                unit: 'day',
                value: shippingRate.maxDeliveryDays
              }
            }
          }
        })
      );

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        line_items,
        mode: 'payment',
        success_url: `${env.BASE_URL}/success/{CHECKOUT_SESSION_ID}/`,
        cancel_url: `${env.BASE_URL}/cart/`,
        allow_promotion_codes: true,
        shipping_options: stripeShippingOptions,
        metadata: recipientShippingAddress
      });
    } catch (e: any) {
      console.log(`Error creating checkout session: ${e.message}`);
      return fail(500, { somethingWentWrong: true });
    }

    if (session.url) {
      throw redirect(303, session.url);
    }
  }
};
